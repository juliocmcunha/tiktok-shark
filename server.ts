/**
 * server.ts
 * -----------------------------------------------------------------------------
 * Servidor intermediário: TikTok LIVE  ->  Node.js  ->  Roblox (polling HTTP)
 *
 * Fluxo:
 *   [TikTok LIVE] --> [este servidor] <-- GET /api/events (polling) -- [Roblox]
 *
 * Responsabilidades:
 *   - Conectar de forma estável à live de um usuário do TikTok.
 *   - Reconectar automaticamente (backoff exponencial) se a conexão cair.
 *   - Acumular eventos (gift / like / chat) em uma fila em memória.
 *   - Expor GET /api/events protegido por header `x-api-key`, que devolve a
 *     fila e a limpa imediatamente (para o Roblox não processar duplicado).
 * -----------------------------------------------------------------------------
 */

import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import * as TikTokLive from 'tiktok-live-connector';

// A v2 da lib pode expor os símbolos de formas ligeiramente diferentes entre
// versões. Fazemos import de namespace e desestruturamos para ficar robusto.
const { TikTokLiveConnection, WebcastEvent } = TikTokLive;

// -----------------------------------------------------------------------------
// 1. Configuração / variáveis de ambiente
// -----------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);
const TIKTOK_USERNAME = (process.env.TIKTOK_USERNAME ?? '').replace(/^@/, '').trim();
const API_SECRET_KEY = process.env.API_SECRET_KEY ?? '';

// Opcionais (têm defaults sensatos)
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE ?? 500);
const BASE_RECONNECT_DELAY_MS = Number(process.env.BASE_RECONNECT_DELAY_MS ?? 3000);
const MAX_RECONNECT_DELAY_MS = Number(process.env.MAX_RECONNECT_DELAY_MS ?? 60000);
// Chave da EulerStream (opcional, mas recomendada em produção — ver README).
const SIGN_API_KEY = process.env.SIGN_API_KEY ?? '';

function fatal(msg: string): never {
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
}

if (!TIKTOK_USERNAME) fatal('TIKTOK_USERNAME não definido no .env');
if (!API_SECRET_KEY) fatal('API_SECRET_KEY não definido no .env');
if (API_SECRET_KEY.length < 16) {
  console.warn('[WARN] API_SECRET_KEY é curta. Use uma chave longa e aleatória em produção.');
}

// Configura o serviço de assinatura (EulerStream) se uma chave foi fornecida.
// Feito de forma defensiva para não quebrar caso a versão da lib não exporte SignConfig.
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

// -----------------------------------------------------------------------------
// 4. Conexão com a TikTok LIVE + reconexão automática
// -----------------------------------------------------------------------------

const connection = new TikTokLiveConnection(TIKTOK_USERNAME, {
  // Mantemos leve: não buscamos info estendida de presentes por padrão.
  enableExtendedGiftInfo: false,
} as any);

let isConnected = false;
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
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
  if (isConnecting || isConnected || shuttingDown) return;
  isConnecting = true;
  try {
    const state: any = await connection.connect();
    isConnected = true;
    reconnectAttempts = 0;
    log(`✅ Conectado à live de @${TIKTOK_USERNAME} (roomId: ${state?.roomId ?? 'desconhecido'}).`);
  } catch (err) {
    isConnected = false;
    log(`❌ Falha ao conectar em @${TIKTOK_USERNAME}: ${errMessage(err)}`);
    // Motivo comum: o usuário NÃO está ao vivo neste momento. Continuamos tentando.
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
  scheduleReconnect(); // o host pode voltar ao vivo mais tarde
});

connection.on(WebcastEvent.ERROR, (err: any) => {
  log(`Evento: ERROR -> ${errMessage(err?.exception ?? err)}`);
});

// -- Eventos de conteúdo (o que interessa pro jogo) ---------------------------

// GIFT: presentes. Presentes "streakable" (giftType === 1) disparam vários
// eventos enquanto a streak acontece; só processamos quando `repeatEnd` é true
// para não enfileirar duplicatas.
connection.on(WebcastEvent.GIFT, (data: any) => {
  const giftType = data?.giftDetails?.giftType ?? data?.giftType;
  const repeatEnd = data?.repeatEnd === true;
  if (giftType === 1 && !repeatEnd) return; // streak em andamento -> ignora

  enqueue({
    id: nextId(),
    type: 'gift',
    timestamp: new Date().toISOString(),
    user: extractUser(data),
    giftId: numOrNull(data?.giftId),
    giftName: String(data?.giftDetails?.giftName ?? data?.giftName ?? 'Unknown'),
    repeatCount: numOr(data?.repeatCount, 1),
    diamondCount: numOr(data?.giftDetails?.diamondCount ?? data?.diamondCount, 0),
  });
});

// LIKE: curtidas em lote. (Em lives com muitos espectadores o TikTok nem sempre
// dispara este evento — comportamento da própria plataforma.)
connection.on(WebcastEvent.LIKE, (data: any) => {
  enqueue({
    id: nextId(),
    type: 'like',
    timestamp: new Date().toISOString(),
    user: extractUser(data),
    likeCount: numOr(data?.likeCount, 0),
    totalLikeCount: numOr(data?.totalLikeCount, 0),
  });
});

// CHAT: comentários no chat.
connection.on(WebcastEvent.CHAT, (data: any) => {
  const comment = typeof data?.comment === 'string' ? data.comment : '';
  if (!comment) return;
  enqueue({
    id: nextId(),
    type: 'chat',
    timestamp: new Date().toISOString(),
    user: extractUser(data),
    comment,
  });
});

// -----------------------------------------------------------------------------
// 5. API HTTP (Express)
// -----------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

// Comparação de chaves em tempo constante (evita timing attacks). Fazemos hash
// dos dois lados para obter buffers de tamanho fixo e igual.
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

// Health check público (sem auth) — útil para monitorar o processo.
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    username: TIKTOK_USERNAME,
    liveConnected: isConnected,
    queued: eventQueue.length,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Endpoint principal: o Roblox faz polling aqui.
// Retorna a fila acumulada e a esvazia IMEDIATAMENTE (drain atômico —
// o Node é single-threaded, então este handler síncrono não sofre corrida).
app.get('/api/events', requireApiKey, (_req: Request, res: Response) => {
  const events = eventQueue.splice(0, eventQueue.length);
  res.json({
    count: events.length,
    serverTime: new Date().toISOString(),
    events,
  });
});

// -----------------------------------------------------------------------------
// 6. Boot + shutdown gracioso
// -----------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  log(`🌐 Servidor HTTP ouvindo na porta ${PORT}.`);
  log(`👀 Monitorando a live de @${TIKTOK_USERNAME}...`);
  void connectToLive();
});

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Recebido ${signal}. Encerrando...`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try {
    connection.disconnect();
  } catch {
    /* ignora erros ao desconectar durante shutdown */
  }
  server.close(() => process.exit(0));
  // Failsafe: força a saída se o close travar.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${errMessage(reason)}`);
});
