/**
 * server.ts  (ponto de entrada / "maestro")
 * -----------------------------------------------------------------------------
 * Junta as peças:
 *   config.ts    -> configuração + detecção de ambiente
 *   events.ts    -> fila de eventos + emissores
 *   tiktok.ts    -> conexão com a live
 *   assistant.ts -> assistente (visual/console) + console de comandos
 *
 * Aqui ficam: o app HTTP (health / events / simulate), o console de TESTE
 * (gift/like/chat/...) e o main() que amarra tudo.
 * -----------------------------------------------------------------------------
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';

import {
  settings,
  configComplete,
  loadEnvIntoProcess,
  refreshSettings,
  applyEnvUpdates,
  KNOWN_KEYS,
  maskKey,
  log,
  errMessage,
} from './config.js';
import {
  eventQueue,
  emitGift,
  emitLike,
  emitChat,
  simUser,
  numOr,
  numOrNull,
  DEFAULT_SIM_USER,
} from './events.js';
import { setupConnection, connectToLive, disconnect, isLiveConnected } from './tiktok.js';
import { registerConfigRoutes, runSetupAssistant, startConsole, closeConsole } from './assistant.js';

// -----------------------------------------------------------------------------
// App HTTP
// -----------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-api-key') ?? '';
  if (!provided || !settings.apiKey || !safeEqual(provided, settings.apiKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    mode: settings.simulateOnly ? 'simulate_only' : 'live',
    consoleEnabled: settings.enableConsole,
    username: settings.username,
    liveConnected: settings.simulateOnly ? false : isLiveConnected(),
    queued: eventQueue.length,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/events', requireApiKey, (_req: Request, res: Response) => {
  const events = eventQueue.splice(0, eventQueue.length);
  res.json({ count: events.length, serverTime: new Date().toISOString(), events });
});

app.post('/api/simulate', requireApiKey, (req: Request, res: Response): void => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const type = String(body.type ?? '').toLowerCase();
  if (type === 'gift' || type === 'donate') {
    const ev = emitGift({
      user: simUser(body.uniqueId),
      giftId: numOrNull(body.giftId),
      giftName: String(body.giftName ?? 'Rose'),
      repeatCount: Math.max(1, numOr(body.repeatCount, 1)),
      diamondCount: Math.max(0, numOr(body.diamondCount, 1)),
      simulated: true,
    });
    res.json({ ok: true, event: ev });
    return;
  }
  if (type === 'like') {
    const c = Math.max(1, numOr(body.likeCount, 1));
    const ev = emitLike({ user: simUser(body.uniqueId), likeCount: c, totalLikeCount: Math.max(c, numOr(body.totalLikeCount, c)), simulated: true });
    res.json({ ok: true, event: ev });
    return;
  }
  if (type === 'chat') {
    const comment = String(body.comment ?? '').trim();
    if (!comment) {
      res.status(400).json({ ok: false, error: 'comment vazio' });
      return;
    }
    const ev = emitChat({ user: simUser(body.uniqueId), comment, simulated: true });
    res.json({ ok: true, event: ev });
    return;
  }
  res.status(400).json({ ok: false, error: 'type inválido (use gift | like | chat)' });
});

registerConfigRoutes(app);

let server: ReturnType<typeof app.listen> | null = null;
let boundPort = 0;
const baseUrl = (): string => 'http://localhost:' + (boundPort || settings.port);

// -----------------------------------------------------------------------------
// Console de TESTE (gift/like/chat/...) + config/set/setup
// -----------------------------------------------------------------------------

const LIVE_KEYS = new Set(['API_SECRET_KEY', 'MAX_QUEUE_SIZE']);

function printHelp(): void {
  console.log(`
┌─ Comandos ─────────────────────────────────────────────────────────────────┐
  CONFIGURAÇÃO
    config                                   mostra a configuração atual
    set <chave> <valor>                      altera uma chave do .env
    setup                                    reabre o assistente (visual/console)
  TESTE (mesma fila que o Roblox lê)
    gift   <nome> [qtd] [diamantes] [@user]  ex: gift Rose 5 1 @fulano
    donate ...                               (apelido de "gift")
    like   [qtd] [@user]                     ex: like 50
    chat   [@user] <mensagem>                ex: chat @ciclano vamooo!
    flood  [n]                               injeta n eventos aleatórios
  UTIL
    status | queue | clear | help | quit
└────────────────────────────────────────────────────────────────────────────┘`);
}

function showConfig(): void {
  console.log('\n── Configuração atual ──');
  console.log('SIMULATE_ONLY: ' + settings.simulateOnly);
  console.log('TIKTOK_USER  : ' + (settings.username ? '@' + settings.username : '(vazio)'));
  console.log('PORT         : ' + settings.port);
  console.log('API_SECRET   : ' + maskKey(settings.apiKey));
  console.log('MAX_QUEUE    : ' + settings.maxQueueSize);
  console.log('(altere com: set <chave> <valor>  |  ou:  setup)\n');
}

function setConfigValue(rawKey: string, value: string): void {
  const key = rawKey.toUpperCase();
  if (!KNOWN_KEYS.has(key)) {
    console.log(`Chave desconhecida: "${rawKey}". Conhecidas: ${[...KNOWN_KEYS].join(', ')}`);
    return;
  }
  applyEnvUpdates({ [key]: value });
  console.log(`✅ ${key} salvo.` + (LIVE_KEYS.has(key) ? ' (já em vigor)' : ' Reinicie para aplicar por completo.'));
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function handleCommand(rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;
  const firstSpace = line.indexOf(' ');
  const cmd = (firstSpace === -1 ? line : line.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? '' : line.slice(firstSpace + 1).trim();
  const tokens = rest ? rest.split(/\s+/) : [];

  switch (cmd) {
    case 'help':
    case '?':
      printHelp();
      break;

    case 'config':
      showConfig();
      break;

    case 'set': {
      if (tokens.length < 2) {
        console.log('Uso: set <chave> <valor>   (ex: set TIKTOK_USERNAME meucanal)');
        break;
      }
      const key = tokens[0];
      const value = rest.slice(key.length).trim();
      setConfigValue(key, value);
      break;
    }

    case 'setup':
      void runSetupAssistant({ baseUrl: baseUrl(), force: true }).then(() => {
        startConsole(handleCommand, () => shutdown('stdin'));
      });
      break;

    case 'gift':
    case 'donate': {
      let uniqueId: string | undefined;
      const positional: string[] = [];
      for (const t of tokens) {
        if (t.startsWith('@')) uniqueId = t.slice(1);
        else positional.push(t);
      }
      const first = positional[0];
      const nameIsNumeric = first !== undefined && !Number.isNaN(Number(first));
      const giftName = first && !nameIsNumeric ? stripQuotes(first) : 'Rose';
      const numbers = positional.filter((p) => !Number.isNaN(Number(p))).map(Number);
      const repeatCount = Math.max(1, numbers[0] ?? 1);
      const diamondCount = Math.max(0, numbers[1] ?? 1);
      const ev = emitGift({ user: simUser(uniqueId), giftId: null, giftName, repeatCount, diamondCount, simulated: true });
      console.log(`🎁 [SIM] gift "${ev.giftName}" x${ev.repeatCount} (${ev.diamondCount}💎) de @${ev.user.uniqueId} → fila (id ${ev.id}, total ${eventQueue.length}).`);
      break;
    }

    case 'like': {
      let uniqueId: string | undefined;
      let count = 1;
      for (const t of tokens) {
        if (t.startsWith('@')) uniqueId = t.slice(1);
        else if (!Number.isNaN(Number(t))) count = Math.max(1, Number(t));
      }
      const ev = emitLike({ user: simUser(uniqueId), likeCount: count, totalLikeCount: count, simulated: true });
      console.log(`👍 [SIM] like x${ev.likeCount} de @${ev.user.uniqueId} → fila (id ${ev.id}, total ${eventQueue.length}).`);
      break;
    }

    case 'chat': {
      let user = { ...DEFAULT_SIM_USER };
      let message = rest;
      if (rest.startsWith('@')) {
        const sp = rest.indexOf(' ');
        const handle = sp === -1 ? rest : rest.slice(0, sp);
        message = sp === -1 ? '' : rest.slice(sp + 1).trim();
        user = simUser(handle);
      }
      if (!message) {
        console.log('Uso: chat [@user] <mensagem>');
        break;
      }
      const ev = emitChat({ user, comment: message, simulated: true });
      console.log(`💬 [SIM] chat de @${ev.user.uniqueId}: "${ev.comment}" → fila (id ${ev.id}, total ${eventQueue.length}).`);
      break;
    }

    case 'flood': {
      const n = Math.min(200, Math.max(1, Number(tokens[0]) || 10));
      const giftNames = ['Rose', 'GG', 'Heart', 'Galaxy', 'Lion'];
      for (let i = 0; i < n; i += 1) {
        const pick = Math.floor(Math.random() * 3);
        if (pick === 0) {
          emitGift({
            user: simUser(`bot_${i}`),
            giftId: null,
            giftName: giftNames[Math.floor(Math.random() * giftNames.length)] ?? 'Rose',
            repeatCount: 1 + Math.floor(Math.random() * 5),
            diamondCount: 1 + Math.floor(Math.random() * 100),
            simulated: true,
          });
        } else if (pick === 1) {
          const c = 1 + Math.floor(Math.random() * 50);
          emitLike({ user: simUser(`bot_${i}`), likeCount: c, totalLikeCount: c, simulated: true });
        } else {
          emitChat({ user: simUser(`bot_${i}`), comment: `mensagem ${i}`, simulated: true });
        }
      }
      console.log(`🌊 [SIM] ${n} evento(s) aleatório(s) injetado(s). Fila: ${eventQueue.length}.`);
      break;
    }

    case 'status':
      console.log(
        `modo: ${settings.simulateOnly ? 'TESTE (sem TikTok)' : 'ao vivo'} | live conectada: ${isLiveConnected()} | fila: ${eventQueue.length} | usuário: @${settings.username || '(nenhum)'}`,
      );
      break;

    case 'queue':
      console.log(eventQueue.length === 0 ? 'Fila vazia.' : JSON.stringify(eventQueue, null, 2));
      break;

    case 'clear': {
      const n = eventQueue.length;
      eventQueue.length = 0;
      console.log(`Fila limpa (${n} evento(s) removido(s)).`);
      break;
    }

    case 'quit':
    case 'exit':
      shutdown('console exit');
      break;

    default:
      console.log(`Comando desconhecido: "${cmd}". Digite "help".`);
  }
}

// -----------------------------------------------------------------------------
// Shutdown
// -----------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Encerrando (${reason})...`);
  closeConsole();
  disconnect();
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log('unhandledRejection: ' + errMessage(reason)));

// -----------------------------------------------------------------------------
// main()
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvIntoProcess();
  refreshSettings();

  await new Promise<void>((resolve, reject) => {
    const s = app.listen(settings.port);
    server = s;
    s.once('listening', () => resolve());
    s.once('error', (err) => reject(err));
  });
  boundPort = settings.port;
  log(`🌐 Servidor HTTP ouvindo na porta ${boundPort}.`);

  // Configurar, se necessário (bloqueia até concluir).
  if (!configComplete()) {
    await runSetupAssistant({ baseUrl: baseUrl() });
  }

  // Já configurado — conecta à live e liga o console de teste.
  setupConnection();
  if (settings.simulateOnly) {
    log('🧪 MODO TESTE: sem conexão com o TikTok. Use o console para gerar eventos.');
  } else {
    log(`👀 Monitorando a live de @${settings.username}...`);
    void connectToLive();
  }

  log('⚙️  Configuração local: ' + baseUrl() + '/config');

  if (settings.enableConsole) {
    startConsole(handleCommand, () => shutdown('stdin'));
    printHelp();
  } else {
    log('Console desativado (sem terminal). Configure em ' + baseUrl() + '/config ou defina ENABLE_CONSOLE=true.');
  }
}

main().catch((err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[FATAL] A porta ${settings.port} já está em uso. Troque com: set PORT <outra> (ou edite o .env).`);
  } else {
    console.error('[FATAL] ' + errMessage(err));
  }
  process.exit(1);
});
