/**
 * events.ts
 * -----------------------------------------------------------------------------
 * Modelo de evento, fila em memória e "emissores". A live real (tiktok.ts) e a
 * simulação (console/HTTP) usam os MESMOS emissores, então tudo cai na mesma
 * fila que o Roblox lê em GET /api/events.
 */

import { settings, log } from './config.js';

export interface EventUser {
  uniqueId: string;
  nickname: string;
  userId: string;
}
export interface BaseEvent {
  id: number;
  timestamp: string;
  user: EventUser;
  simulated?: boolean;
}
export interface GiftEvent extends BaseEvent {
  type: 'gift';
  giftId: number | null;
  giftName: string;
  repeatCount: number;
  diamondCount: number;
}
export interface LikeEvent extends BaseEvent {
  type: 'like';
  likeCount: number;
  totalLikeCount: number;
}
export interface ChatEvent extends BaseEvent {
  type: 'chat';
  comment: string;
}
export type LiveEvent = GiftEvent | LikeEvent | ChatEvent;

export const eventQueue: LiveEvent[] = [];
let eventIdCounter = 0;

function nextId(): number {
  eventIdCounter += 1;
  return eventIdCounter;
}

function enqueue(event: LiveEvent): void {
  eventQueue.push(event);
  if (eventQueue.length > settings.maxQueueSize) {
    const dropCount = eventQueue.length - settings.maxQueueSize;
    eventQueue.splice(0, dropCount);
    log(`Fila cheia (> ${settings.maxQueueSize}). Descartados ${dropCount} evento(s) antigo(s).`);
  }
}

// ---- helpers reutilizados por live e simulação ------------------------------

export function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
export function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
export function extractUser(data: any): EventUser {
  const u = data?.user ?? {};
  return {
    uniqueId: String(u?.uniqueId ?? data?.uniqueId ?? ''),
    nickname: String(u?.nickname ?? data?.nickname ?? ''),
    userId: String(u?.userId ?? data?.userId ?? ''),
  };
}
export const DEFAULT_SIM_USER: EventUser = { uniqueId: 'test_user', nickname: 'Test User', userId: '0' };
export function simUser(uniqueId?: unknown): EventUser {
  const raw = typeof uniqueId === 'string' ? uniqueId.replace(/^@/, '').trim() : '';
  if (!raw) return { ...DEFAULT_SIM_USER };
  return { uniqueId: raw, nickname: raw, userId: '0' };
}

// ---- emissores --------------------------------------------------------------

export function emitGift(p: {
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

export function emitLike(p: {
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

export function emitChat(p: { user: EventUser; comment: string; simulated?: boolean }): ChatEvent {
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
