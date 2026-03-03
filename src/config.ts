import * as fs from 'node:fs';
import * as path from 'node:path';

// Load .env manually (no dotenv dependency)
function loadEnv(): void {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadEnv();

function int(key: string, def: number): number {
  const v = process.env[key];
  if (!v) return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

function str(key: string, def: string): string {
  return process.env[key] ?? def;
}

export const config = {
  port:                   int('PORT', 3000),
  host:                   str('HOST', 'localhost'),
  logLevel:               str('LOG_LEVEL', 'info'),
  sessionTtlMs:           int('SESSION_TTL_HOURS', 24) * 60 * 60 * 1000,
  serverTimeoutMs:        int('SERVER_TIMEOUT_MINUTES', 5) * 60 * 1000,
  ladderRebuildIntervalMs:int('LADDER_REBUILD_INTERVAL_MINUTES', 10) * 60 * 1000,
} as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[config.logLevel] ?? 1;

function timestamp(): string {
  return new Date().toISOString();
}

export const log = {
  debug: (msg: string, data?: unknown) => {
    if (currentLevel <= 0) console.log(`[${timestamp()}] DEBUG ${msg}`, data ?? '');
  },
  info: (msg: string, data?: unknown) => {
    if (currentLevel <= 1) console.log(`[${timestamp()}] INFO  ${msg}`, data ?? '');
  },
  warn: (msg: string, data?: unknown) => {
    if (currentLevel <= 2) console.warn(`[${timestamp()}] WARN  ${msg}`, data ?? '');
  },
  error: (msg: string, data?: unknown) => {
    if (currentLevel <= 3) console.error(`[${timestamp()}] ERROR ${msg}`, data ?? '');
  },
};
