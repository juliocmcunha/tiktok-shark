/**
 * config.ts
 * -----------------------------------------------------------------------------
 * Configuração do programa: leitura/escrita do .env (ao lado do executável),
 * "settings" derivados, e DETECÇÃO DE AMBIENTE (se há interface gráfica /
 * terminal), usada para decidir entre o assistente visual e o de console.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// ---- utilitários genéricos --------------------------------------------------

export function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
export function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on|sim)$/i.test(value);
}

// ---- onde fica o .env (pasta do EXECUTÁVEL quando empacotado; senão, cwd) ----

function resolveBaseDir(): string {
  if (process.env.CONFIG_DIR) return process.env.CONFIG_DIR;
  const exeName = path.basename(process.execPath).toLowerCase();
  const runningAsBinary = !exeName.startsWith('node') && !exeName.startsWith('bun');
  return runningAsBinary ? path.dirname(process.execPath) : process.cwd();
}
export const BASE_DIR = resolveBaseDir();
export const ENV_PATH = path.join(BASE_DIR, '.env');

// ---- chaves conhecidas do .env ----------------------------------------------

export const FIELD_INFO: ReadonlyArray<{ key: string; comment: string; core: boolean }> = [
  { key: 'PORT', comment: 'Porta do servidor HTTP', core: true },
  { key: 'TIKTOK_USERNAME', comment: 'Usuário do TikTok (sem @). Obrigatório fora do modo teste.', core: true },
  { key: 'API_SECRET_KEY', comment: 'Chave secreta (a MESMA no Config.ApiKey do Roblox).', core: true },
  { key: 'SIMULATE_ONLY', comment: 'true = modo teste, sem conectar no TikTok.', core: true },
  { key: 'ENABLE_CONSOLE', comment: 'true/false p/ forçar o console (padrão: liga se houver terminal).', core: false },
  { key: 'UI_MODE', comment: 'gui | console | headless — força o tipo de assistente (opcional).', core: false },
  { key: 'MAX_QUEUE_SIZE', comment: 'Máximo de eventos na fila (protege memória).', core: false },
  { key: 'BASE_RECONNECT_DELAY_MS', comment: 'Atraso base de reconexão (ms).', core: false },
  { key: 'MAX_RECONNECT_DELAY_MS', comment: 'Atraso máximo de reconexão (ms).', core: false },
  { key: 'SIGN_API_KEY', comment: 'Chave EulerStream (opcional, recomendada em produção).', core: false },
];
export const KNOWN_KEYS = new Set<string>(FIELD_INFO.map((f) => f.key));

export type EnvMap = Record<string, string>;

export function readEnvMap(): EnvMap {
  try {
    if (fs.existsSync(ENV_PATH)) return dotenv.parse(fs.readFileSync(ENV_PATH));
  } catch (err) {
    console.warn('[WARN] Não consegui ler o .env: ' + errMessage(err));
  }
  return {};
}

export function writeEnvMap(map: EnvMap): void {
  const lines: string[] = [
    '# Configuração do TikTok -> Roblox Bridge',
    '# Gerado/atualizado automaticamente pelo programa.',
    '',
  ];
  for (const field of FIELD_INFO) {
    const value = map[field.key];
    if (value === undefined && !field.core) continue;
    lines.push('# ' + field.comment);
    lines.push(`${field.key}=${value ?? ''}`);
    lines.push('');
  }
  for (const [k, v] of Object.entries(map)) {
    if (!KNOWN_KEYS.has(k)) lines.push(`${k}=${v}`);
  }
  try {
    fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
  } catch (err) {
    console.warn(
      '[WARN] Não consegui gravar o .env em ' +
        ENV_PATH +
        ' (' +
        errMessage(err) +
        '). A configuração vale só nesta sessão. Rode de uma pasta com permissão de escrita.',
    );
  }
}

export function loadEnvIntoProcess(): void {
  dotenv.config({ path: ENV_PATH, override: true });
}

// Aplica um conjunto de mudanças: grava no .env, no process.env e recalcula.
export function applyEnvUpdates(updates: EnvMap): void {
  const map = readEnvMap();
  for (const [k, v] of Object.entries(updates)) {
    map[k] = v;
    process.env[k] = v;
  }
  writeEnvMap(map);
  refreshSettings();
}

// ---- settings ---------------------------------------------------------------

export interface Settings {
  port: number;
  username: string;
  apiKey: string;
  simulateOnly: boolean;
  enableConsole: boolean;
  maxQueueSize: number;
  baseReconnectMs: number;
  maxReconnectMs: number;
  signApiKey: string;
}

function computeSettings(): Settings {
  return {
    port: Number(process.env.PORT ?? 3000) || 3000,
    username: (process.env.TIKTOK_USERNAME ?? '').replace(/^@/, '').trim(),
    apiKey: process.env.API_SECRET_KEY ?? '',
    simulateOnly: boolEnv(process.env.SIMULATE_ONLY, false),
    enableConsole: boolEnv(process.env.ENABLE_CONSOLE, Boolean(process.stdin.isTTY)),
    maxQueueSize: Number(process.env.MAX_QUEUE_SIZE ?? 500) || 500,
    baseReconnectMs: Number(process.env.BASE_RECONNECT_DELAY_MS ?? 3000) || 3000,
    maxReconnectMs: Number(process.env.MAX_RECONNECT_DELAY_MS ?? 60000) || 60000,
    signApiKey: process.env.SIGN_API_KEY ?? '',
  };
}

// Objeto mutado no lugar (todos que importam veem sempre o valor atual).
export const settings: Settings = computeSettings();

export function refreshSettings(): void {
  Object.assign(settings, computeSettings());
}

export function configComplete(s: Settings = settings): boolean {
  if (!s.apiKey) return false;
  if (!s.simulateOnly && !s.username) return false;
  return true;
}

export function generateKey(): string {
  return crypto.randomBytes(24).toString('hex');
}
export function maskKey(key: string): string {
  if (!key) return '(vazia)';
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

// ---- detecção de ambiente ---------------------------------------------------

export function hasTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

// Há como abrir uma janela/navegador neste sistema?
export function canUseGui(): boolean {
  const forced = (process.env.UI_MODE ?? '').toLowerCase();
  if (forced === 'console' || forced === 'headless') return false;
  if (forced === 'gui' || forced === 'web') return true;
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export type UiMode = 'gui' | 'console' | 'headless';

// Decide qual assistente usar.
export function decideUiMode(): UiMode {
  const forced = (process.env.UI_MODE ?? '').toLowerCase();
  if (forced === 'console') return hasTty() ? 'console' : 'headless';
  if (forced === 'gui' || forced === 'web') return 'gui';
  if (canUseGui()) return 'gui';
  if (hasTty()) return 'console';
  return 'headless';
}
