import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
const ENV_ALLOWLIST = new Set<string>();

/**
 * Contribute keys to the union allowlist that `auditEnvAllowlist` checks against.
 * Must be called from the same module that calls `readEnvFile`, typically at
 * module load. Invoking multiple times with overlapping keys is safe.
 */
export function registerEnvAllowlist(keys: string[]): void {
  for (const k of keys) ENV_ALLOWLIST.add(k);
}

/**
 * One-shot audit at startup: warn for any .env key NOT registered by any
 * `readEnvFile` caller. Fires once per process.
 */
let audited = false;
export function auditEnvAllowlist(): void {
  if (audited) return;
  audited = true;
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!ENV_ALLOWLIST.has(key)) {
      logger.warn(
        { key },
        `env: unknown .env key "${key}" — not registered by any readEnvFile allowlist, will be ignored`,
      );
    }
  }
}

/** @internal — for tests only */
export function _resetEnvAllowlistForTests(): void {
  ENV_ALLOWLIST.clear();
  audited = false;
}

export function readEnvFile(keys: string[]): Record<string, string> {
  registerEnvAllowlist(keys);
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
