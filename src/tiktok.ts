/**
 * tiktok.ts
 * -----------------------------------------------------------------------------
 * Conexão com a TikTok LIVE + reconexão automática. Transforma os eventos da
 * live nos eventos da nossa fila (via events.ts).
 */

import * as TikTokLive from 'tiktok-live-connector';
import { settings, log, errMessage } from './config.js';
import { emitGift, emitLike, emitChat, extractUser, numOr, numOrNull } from './events.js';

const { TikTokLiveConnection, WebcastEvent } = TikTokLive;

let connection: InstanceType<typeof TikTokLiveConnection> | null = null;
let isConnected = false;
let isConnecting = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let stopping = false;

export function isLiveConnected(): boolean {
  return isConnected;
}

function scheduleReconnect(): void {
  if (stopping || settings.simulateOnly || reconnectTimer || !connection) return;
  reconnectAttempts += 1;
  const backoff = Math.min(settings.maxReconnectMs, settings.baseReconnectMs * 2 ** (reconnectAttempts - 1));
  const delay = backoff + Math.floor(Math.random() * 1000);
  log(`Reagendando conexão em ${Math.round(delay / 1000)}s (tentativa #${reconnectAttempts}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectToLive();
  }, delay);
}

export async function connectToLive(): Promise<void> {
  if (isConnecting || isConnected || stopping || settings.simulateOnly || !connection) return;
  const conn = connection;
  isConnecting = true;
  try {
    const state: any = await conn.connect();
    isConnected = true;
    reconnectAttempts = 0;
    log(`✅ Conectado à live de @${settings.username} (roomId: ${state?.roomId ?? '?'}).`);
  } catch (err) {
    isConnected = false;
    log(`❌ Falha ao conectar em @${settings.username}: ${errMessage(err)}`);
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

// Cria a conexão e registra os handlers. Chame uma vez, após configurar.
export function setupConnection(): void {
  if (settings.signApiKey) {
    const SignConfig = (TikTokLive as unknown as { SignConfig?: { apiKey?: string } }).SignConfig;
    if (SignConfig) SignConfig.apiKey = settings.signApiKey;
  }

  connection = new TikTokLiveConnection(settings.username || 'placeholder', {
    enableExtendedGiftInfo: false,
  } as any);

  // A tipagem da lib muda entre versões: o `.on` nem sempre aparece no tipo, e os
  // eventos de CONTROLE (connected/disconnected/error) ficam em outro enum
  // (ControlEvent), não no WebcastEvent. Por isso ligamos os eventos por um
  // emissor com cast e usamos o ControlEvent quando existe, com strings de
  // fallback. Os eventos de DADOS (gift/like/chat/stream_end) seguem no WebcastEvent.
  const conn = connection as any;
  const Control = ((TikTokLive as any).ControlEvent ?? {}) as Record<string, string>;
  const ON_CONNECTED = Control.CONNECTED ?? 'connected';
  const ON_DISCONNECTED = Control.DISCONNECTED ?? 'disconnected';
  const ON_ERROR = Control.ERROR ?? 'error';
  const ON_STREAM_END = Control.STREAM_END ?? WebcastEvent.STREAM_END;

  conn.on(ON_CONNECTED, () => {
    isConnected = true;
    reconnectAttempts = 0;
    log('Evento: CONNECTED.');
  });
  conn.on(ON_DISCONNECTED, () => {
    isConnected = false;
    log('Evento: DISCONNECTED. Tentando reconectar.');
    scheduleReconnect();
  });
  conn.on(ON_STREAM_END, () => {
    isConnected = false;
    log('Evento: STREAM_END (a live foi encerrada).');
    scheduleReconnect();
  });
  conn.on(ON_ERROR, (err: any) => {
    log(`Evento: ERROR -> ${errMessage(err?.exception ?? err)}`);
  });

  conn.on(WebcastEvent.GIFT, (data: any) => {
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
  conn.on(WebcastEvent.LIKE, (data: any) => {
    emitLike({
      user: extractUser(data),
      likeCount: numOr(data?.likeCount, 0),
      totalLikeCount: numOr(data?.totalLikeCount, 0),
    });
  });
  conn.on(WebcastEvent.CHAT, (data: any) => {
    const comment = typeof data?.comment === 'string' ? data.comment : '';
    if (!comment) return;
    emitChat({ user: extractUser(data), comment });
  });
}

export function disconnect(): void {
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (connection) {
    try {
      connection.disconnect();
    } catch {
      /* ignora erros ao desconectar durante o shutdown */
    }
  }
}
