/**
 * server.ts
 * -----------------------------------------------------------------------------
 * Servidor intermediário: TikTok LIVE  ->  Node.js  ->  Roblox (polling HTTP)
 *
 * Fluxo:
 *   [TikTok LIVE] --> [este servidor] <-- GET /api/events (polling) -- [Roblox]
 *
 * Recursos:
 *   - Conexão estável com a live + reconexão automática (backoff exponencial).
 *   - Fila em memória de eventos (gift / like / chat).
 *   - GET /api/events protegido por header `x-api-key` (retorna a fila e limpa).
 *
 *   >>> MODO DE TESTE (sem precisar estar ao vivo) <<<
 *   - Console interativo (stdin): simule gift/like/chat digitando comandos.
 *     Os eventos simulados caem na MESMA fila lida pelo Roblox.
 *   - SIMULATE_ONLY=true: sobe só o HTTP + console, sem conectar no TikTok.
 *   - POST /api/simulate (protegido): dispara eventos de teste via HTTP.
 * -----------------------------------------------------------------------------
 */

import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import * as readline from 'node:readline';
import * as TikTokLive from 'tiktok-live-connector';

// A v2 da lib pode expor os símbolos de formas ligeiramente diferentes entre
// versões. Fazemos import de namespace e desestruturamos para ficar robusto.
const { TikTokLiveConnection, WebcastEvent } = TikTokLive;

// -----------------------------------------------------------------------------
// 1. Configuração / variáveis de ambiente
// -----------------------------------------------------------------------------

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

const PORT = Number(process.env.PORT ?? 3000);
const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME ?? '').replace(/^@/, '').trim();
const API_SECRET_KEY = process.env.API_SECRET_KEY ?? '';

// Modo de teste: não conecta no TikTok, só HTTP + console.
const SIMULATE_ONLY = boolEnv(process.env.SIMULATE_ONLY, false);
// Console interativo: por padrão liga se houver terminal (TTY).
const ENABLE_CONSOLE = boolEnv(process.env.ENABLE_CONSOLE, Boolean(process.stdin.isTTY));

// Opcionais (têm defaults sensatos)
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE ?? 500);
const BASE_RECONNECT_DELAY_MS = Number(process.env.BASE_RECONNECT_DELAY_MS ?? 3000);
const MAX_RECONNECT_DELAY_MS = Number(process.env.MAX_RECONNECT_DELAY_MS ?? 60000);
// Chave da EulerStream (opcional, recomendada em produção — ver README).
const SIGN_API_KEY = process.env.SIGN_API_KEY ?? '';

function fatal(msg: string): never {
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
}

if (!SIMULATE_ONLY && !TIKTOK_USERNAME) {
  fatal('TIKTOK_USERNAME não definido no .env (ou use SIMULATE_ONLY=true para testar sem live).');
}
if (!API_SECRET_KEY) fatal('API_SECRET_KEY não definido no .env');
if (API_SECRET_KEY.length < 16) {
  console.warn('[WARN] API_SECRET_KEY é curta. Use uma chave longa e aleatória em produção.');
}

// Configura o serviço de assinatura (EulerStream) se uma chave foi fornecida.
const SignConfig = (TikTokLive as unknown as { SignConfig?: { apiKey?: string } }).SignConfig;
if (SIGN_API_KEY && SignConfig) {
  SignConfig.apiKey = SIGN_API_KEY;
}

// -----------------------------------------------------------------------------
// 2. Tipos dos eventos e fila em memória
// -----------------------------------------------------------------------------

interface EventUser {
  uniqueId: string; // @handle do TikTok
  nickname: string; // nome de exibição
  userId: string;
}

interface BaseEvent {
  id: number; // id incremental para o Roblox deduplicar, se quiser
  timestamp: string; // ISO 8601
  user: EventUser;
  simulated?: boolean; // true quando veio do console/POST de teste
}

interface GiftEvent extends BaseEvent {
  type: 'gift';
  giftId: number | null;
  giftName: string;
  repeatCount: number; // quantidade na streak
  diamondCount: number; // valor em diamantes de UMA unidade do presente
}

interface LikeEvent extends BaseEvent {
  type: 'like';
  likeCount: number; // curtidas neste lote
  totalLikeCount: number; // total de curtidas da live
}

interface ChatEvent extends BaseEvent {
  type: 'chat';
  comment: string;
}

type LiveEvent = GiftEvent | LikeEvent | ChatEvent;

const eventQueue: LiveEvent[] = [];
let eventIdCounter = 0;

function nextId(): number {
  eventIdCounter += 1;
  return eventIdCounter;
}

function enqueue(event: LiveEvent): void {
  eventQueue.push(event);
  // Proteção contra crescimento infinito de memória caso o Roblox pare de fazer
  // polling: descartamos os eventos mais antigos.
  if (eventQueue.length > MAX_QUEUE_SIZE) {
    const dropCount = eventQueue.length - MAX_QUEUE_SIZE;
    eventQueue.splice(0, dropCount);
    log(`Fila cheia (> ${MAX_QUEUE_SIZE}). Descartados ${dropCount} evento(s) antigo(s).`);
  }
}

// -----------------------------------------------------------------------------
// 3. Helpers
// -----------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// Extrai dados do usuário de forma tolerante: a lib pode entregar campos
// aninhados em `data.user` (v2) ou no nível raiz (compat/versões antigas).
function extractUser(data: any): EventUser {
  const u = data?.user ?? {};
  return {
    uniqueId: String(u?.uniqueId ?? data?.uniqueId ?? ''),
    nickname: String(u?.nickname ?? data?.nickname ?? ''),
    userId: String(u?.userId ?? data?.userId ?? ''),
  };
}

// Usuário padrão para eventos simulados; aceita um @handle opcional.
const DEFAULT_SIM_USER: EventUser = { uniqueId: 'test_user', nickname: 'Test User', userId: '0' };
function simUser(uniqueId?: unknown): EventUser {
  const raw = typeof uniqueId === 'string' ? uniqueId.replace(/^@/, '').trim() : '';
  if (!raw) return { ...DEFAULT_SIM_USER };
  return { uniqueId: raw, nickname: raw, userId: '0' };
}

// -----------------------------------------------------------------------------
// 4. Construção de eventos (usada tanto pela live real quanto pela simulação)
// -----------------------------------------------------------------------------

function emitGift(p: {
  user: EventUser;
  giftId: number | null;
  giftName: string;
  repeatCount: number;
  diamondCount: number;
  simulated?: boolean;
}): GiftEvent {
  const ev: GiftEvent = {
    id: nextId(),
    type: 'gift',
    timestamp: new Date().toISOString(),
    user: p.user,
    giftId: p.giftId,
    giftName: p.giftName,
    repeatCount: p.repeatCount,
    diamondCount: p.diamondCount,
  };
  if (p.simulated) ev.simulated = true;
  enqueue(ev);
  return ev;
}

function emitLike(p: {
  user: EventUser;
  likeCount: number;
  totalLikeCount: number;
  simulated?: boolean;
}): LikeEvent {
  const ev: LikeEvent = {
    id: nextId(),
    type: 'like',
    timestamp: new Date().toISOString(),
    user: p.user,
    likeCount: p.likeCount,
    totalLikeCount: p.totalLikeCount,
  };
  if (p.simulated) ev.simulated = true;
  enqueue(ev);
  return ev;
}

function emitChat(p: { user: EventUser; comment: string; simulated?: boolean }): ChatEvent {
  const ev: ChatEvent = {
    id: nextId(),
    type: 'chat',
    timestamp: new Date().toISOString(),
    user: p.user,
    comment: p.comment,
  };
  if (p.simulated) ev.simulated = true;
  enqueue(ev);
  return ev;
}

// -----------------------------------------------------------------------------
// 5. Conexão com a TikTok LIVE + reconexão automática
// -----------------------------------------------------------------------------

// O objeto é criado sempre; só não CONECTAMOS quando SIMULATE_ONLY=true.
const connection = new TikTokLiveConnection(TIKTOK_USERNAME || 'placeholder', {
  enableExtendedGiftInfo: false,
} as any);

let isConnected = false;
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function scheduleReconnect(): void {
  if (shuttingDown || SIMULATE_ONLY || reconnectTimer) return;
  reconnectAttempts += 1;
  const backoff = Math.min(
    MAX_RECONNECT_DELAY_MS,
    BASE_RECONNECT_DELAY_MS * 2 ** (reconnectAttempts - 1),
  );
  const jitter = Math.floor(Math.random() * 1000); // evita "thundering herd"
  const delay = backoff + jitter;
  log(`Reagendando conexão em ${Math.round(delay / 1000)}s (tentativa #${reconnectAttempts}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectToLive();
  }, delay);
}

async function connectToLive(): Promise<void> {
  if (isConnecting || isConnected || shuttingDown || SIMULATE_ONLY) return;
  isConnecting = true;
  try {
    const state: any = await connection.connect();
    isConnected = true;
    reconnectAttempts = 0;
    log(`✅ Conectado à live de @${TIKTOK_USERNAME} (roomId: ${state?.roomId ?? 'desconhecido'}).`);
  } catch (err) {
    isConnected = false;
    log(`❌ Falha ao conectar em @${TIKTOK_USERNAME}: ${errMessage(err)}`);
    // Motivo comum: o usuário NÃO está ao vivo. Continuamos tentando.
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

// -- Ciclo de vida da conexão --------------------------------------------------

connection.on(WebcastEvent.CONNECTED, () => {
  isConnected = true;
  reconnectAttempts = 0;
  log('Evento: CONNECTED.');
});

connection.on(WebcastEvent.DISCONNECTED, () => {
  isConnected = false;
  log('Evento: DISCONNECTED. Vou tentar reconectar.');
  scheduleReconnect();
});

connection.on(WebcastEvent.STREAM_END, () => {
  isConnected = false;
  log('Evento: STREAM_END (a live foi encerrada pelo host).');
  scheduleReconnect();
});

connection.on(WebcastEvent.ERROR, (err: any) => {
  log(`Evento: ERROR -> ${errMessage(err?.exception ?? err)}`);
});

// -- Eventos de conteúdo (vindos da live real) --------------------------------

// GIFT: presentes "streakable" (giftType === 1) disparam vários eventos durante
// a streak; só processamos quando `repeatEnd` é true para não duplicar.
connection.on(WebcastEvent.GIFT, (data: any) => {
  const giftType = data?.giftDetails?.giftType ?? data?.giftType;
  if (giftType === 1 && data?.repeatEnd !== true) return;
  emitGift({
    user: extractUser(data),
    giftId: numOrNull(data?.giftId),
    giftName: String(data?.giftDetails?.giftName ?? data?.giftName ?? 'Unknown'),
    repeatCount: numOr(data?.repeatCount, 1),
    diamondCount: numOr(data?.giftDetails?.diamondCount ?? data?.diamondCount, 0),
  });
});

// LIKE: curtidas em lote. (Em lives grandes o TikTok nem sempre dispara.)
connection.on(WebcastEvent.LIKE, (data: any) => {
  emitLike({
    user: extractUser(data),
    likeCount: numOr(data?.likeCount, 0),
    totalLikeCount: numOr(data?.totalLikeCount, 0),
  });
});

// CHAT: comentários.
connection.on(WebcastEvent.CHAT, (data: any) => {
  const comment = typeof data?.comment === 'string' ? data.comment : '';
  if (!comment) return;
  emitChat({ user: extractUser(data), comment });
});

// -----------------------------------------------------------------------------
// 6. Console de testes (stdin) — simula eventos sem precisar de live
// -----------------------------------------------------------------------------

let consoleRl: readline.Interface | null = null;

function printHelp(): void {
  console.log(`
┌─ Console de testes — simule eventos da live sem estar ao vivo ─────────────┐
  gift   <nome> [qtd] [diamantes] [@user]   ex: gift Rose 5 1 @fulano
  donate ...                                (apelido de "gift")
  like   [qtd] [@user]                      ex: like 50 @ciclano
  chat   [@user] <mensagem>                 ex: chat @beltrano vamooo!
  flood  [n]                                injeta n eventos aleatórios (padrão 10)
  status                                    estado da conexão e da fila
  queue                                     mostra a fila atual (sem limpar)
  clear                                     limpa a fila
  help | ?                                  mostra esta ajuda
  quit | exit                               encerra o servidor
└────────────────────────────────────────────────────────────────────────────┘
Tudo o que você injetar cai na MESMA fila lida pelo Roblox em GET /api/events.
Se um donate real falhar, é só redigitá-lo aqui (ex: gift Galaxy 1 100).`);
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
      const ev = emitGift({
        user: simUser(uniqueId),
        giftId: null,
        giftName,
        repeatCount,
        diamondCount,
        simulated: true,
      });
      console.log(
        `🎁 [SIM] gift "${ev.giftName}" x${ev.repeatCount} (${ev.diamondCount}💎) ` +
          `de @${ev.user.uniqueId} → fila (id ${ev.id}, total ${eventQueue.length}).`,
      );
      break;
    }

    case 'like': {
      let uniqueId: string | undefined;
      let count = 1;
      for (const t of tokens) {
        if (t.startsWith('@')) uniqueId = t.slice(1);
        else if (!Number.isNaN(Number(t))) count = Math.max(1, Number(t));
      }
      const ev = emitLike({
        user: simUser(uniqueId),
        likeCount: count,
        totalLikeCount: count,
        simulated: true,
      });
      console.log(
        `👍 [SIM] like x${ev.likeCount} de @${ev.user.uniqueId} → fila (id ${ev.id}, total ${eventQueue.length}).`,
      );
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
      console.log(
        `💬 [SIM] chat de @${ev.user.uniqueId}: "${ev.comment}" → fila (id ${ev.id}, total ${eventQueue.length}).`,
      );
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
        `modo: ${SIMULATE_ONLY ? 'SIMULATE_ONLY (sem TikTok)' : 'ao vivo'} | ` +
          `live conectada: ${isConnected} | fila: ${eventQueue.length} | ` +
          `usuário: @${TIKTOK_USERNAME || '(nenhum)'}`,
      );
      break;

    case 'queue':
      if (eventQueue.length === 0) console.log('Fila vazia.');
      else console.log(JSON.stringify(eventQueue, null, 2));
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

function startConsole(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'tiktok> ',
  });
  consoleRl = rl;
  printHelp();
  rl.prompt();
  rl.on('line', (line) => {
    try {
      handleCommand(line);
    } catch (e) {
      console.log(`Erro ao processar comando: ${errMessage(e)}`);
    }
    if (!shuttingDown) rl.prompt();
  });
  rl.on('close', () => {
    if (!shuttingDown) shutdown('stdin fechado (Ctrl+D)');
  });
}

// -----------------------------------------------------------------------------
// 7. API HTTP (Express)
// -----------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Comparação de chaves em tempo constante (evita timing attacks).
function safeEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-api-key') ?? '';
  if (!provided || !safeEqual(provided, API_SECRET_KEY)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Health check público (sem auth).
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    mode: SIMULATE_ONLY ? 'simulate_only' : 'live',
    consoleEnabled: ENABLE_CONSOLE,
    username: TIKTOK_USERNAME,
    liveConnected: SIMULATE_ONLY ? false : isConnected,
    queued: eventQueue.length,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Endpoint principal: o Roblox faz polling aqui. Retorna a fila e a esvazia
// IMEDIATAMENTE (drain atômico — Node é single-threaded, sem corrida).
app.get('/api/events', requireApiKey, (_req: Request, res: Response) => {
  const events = eventQueue.splice(0, eventQueue.length);
  res.json({
    count: events.length,
    serverTime: new Date().toISOString(),
    events,
  });
});

// Simulação via HTTP (protegido). Mesma fila do /api/events. Útil pra curl/Postman
// ou pra você montar um botão de teste depois.
//   Body JSON: { "type": "gift"|"like"|"chat", ...campos }
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
    const ev = emitLike({
      user: simUser(body.uniqueId),
      likeCount: c,
      totalLikeCount: Math.max(c, numOr(body.totalLikeCount, c)),
      simulated: true,
    });
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

// -----------------------------------------------------------------------------
// 8. Boot + shutdown gracioso
// -----------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  log(`🌐 Servidor HTTP ouvindo na porta ${PORT}.`);
  if (SIMULATE_ONLY) {
    log('🧪 MODO SIMULATE_ONLY: sem conexão com o TikTok. Use o console para gerar eventos.');
  } else {
    log(`👀 Monitorando a live de @${TIKTOK_USERNAME}...`);
    void connectToLive();
  }
  if (ENABLE_CONSOLE) {
    startConsole();
  } else {
    log('Console de testes desativado (sem TTY). Use ENABLE_CONSOLE=true ou POST /api/simulate.');
  }
});

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Encerrando (${reason})...`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (consoleRl) {
    try {
      consoleRl.close();
    } catch {
      /* ignora */
    }
  }
  try {
    connection.disconnect();
  } catch {
    /* ignora erros ao desconectar durante shutdown */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${errMessage(reason)}`);
});
