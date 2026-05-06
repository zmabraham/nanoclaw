import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'OLLAMA_ADMIN_TOOLS',
  'TZ',
  'MEDIA_PIPELINE_ENABLED',
  'MEDIA_MAX_BYTES',
  'MEDIA_MAX_AGGREGATE_BYTES',
  'MEDIA_RETAIN_FILES',
  'MEDIA_MAX_FILES',
  'MEDIA_REFERENCE_FLOOR_HOURS',
  'MEDIA_PIPELINE_MAX_CONCURRENCY',
  'LATE_FINALIZE_MAX_RETRIES',
  'LATE_FINALIZE_BACKOFF_MS',
  'LATE_FINALIZE_EXHAUST_COOLDOWN_MS',
  'PROVIDER_PRIMARY',
  'PROVIDER_FAILOVER_COOLDOWN',
  'ZAI_API_KEY',
  'ZAI_BASE_URL',
  'ZAI_DEFAULT_MODEL',
  'ZAI_DEFAULT_HAIKU_MODEL',
  'ZAI_DEFAULT_SONNET_MODEL',
  'ZAI_DEFAULT_OPUS_MODEL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const OLLAMA_ADMIN_TOOLS =
  (process.env.OLLAMA_ADMIN_TOOLS || envConfig.OLLAMA_ADMIN_TOOLS) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// --- Media ingestion pipeline config (added by skill/media-ingestion) ---
// All new keys MUST appear in the readEnvFile([...]) allowlist above or .env edits are silently ignored.

export const MEDIA_PIPELINE_ENABLED =
  process.env.MEDIA_PIPELINE_ENABLED || envConfig.MEDIA_PIPELINE_ENABLED || '0';

// Size/concurrency caps where 0 would leave the pipeline non-functional —
// coerce 0 (and any `<= 0`) back to the default.
function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// Retention/retry/backoff keys where 0 is a legitimate operator setting.
function toNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export const MEDIA_MAX_BYTES = toPositiveInt(
  process.env.MEDIA_MAX_BYTES || envConfig.MEDIA_MAX_BYTES,
  25 * 1024 * 1024,
);
export const MEDIA_MAX_AGGREGATE_BYTES = toPositiveInt(
  process.env.MEDIA_MAX_AGGREGATE_BYTES || envConfig.MEDIA_MAX_AGGREGATE_BYTES,
  50 * 1024 * 1024,
);
export const MEDIA_RETAIN_FILES = toNonNegativeInt(
  process.env.MEDIA_RETAIN_FILES || envConfig.MEDIA_RETAIN_FILES,
  100,
);
export const MEDIA_MAX_FILES = toNonNegativeInt(
  process.env.MEDIA_MAX_FILES || envConfig.MEDIA_MAX_FILES,
  500,
);
export const MEDIA_REFERENCE_FLOOR_HOURS = toNonNegativeInt(
  process.env.MEDIA_REFERENCE_FLOOR_HOURS ||
    envConfig.MEDIA_REFERENCE_FLOOR_HOURS,
  24,
);
export const MEDIA_PIPELINE_MAX_CONCURRENCY = toPositiveInt(
  process.env.MEDIA_PIPELINE_MAX_CONCURRENCY ||
    envConfig.MEDIA_PIPELINE_MAX_CONCURRENCY,
  5,
);
export const LATE_FINALIZE_MAX_RETRIES = toNonNegativeInt(
  process.env.LATE_FINALIZE_MAX_RETRIES || envConfig.LATE_FINALIZE_MAX_RETRIES,
  3,
);
export const LATE_FINALIZE_BACKOFF_MS = toNonNegativeInt(
  process.env.LATE_FINALIZE_BACKOFF_MS || envConfig.LATE_FINALIZE_BACKOFF_MS,
  500,
);
export const LATE_FINALIZE_EXHAUST_COOLDOWN_MS = toNonNegativeInt(
  process.env.LATE_FINALIZE_EXHAUST_COOLDOWN_MS ||
    envConfig.LATE_FINALIZE_EXHAUST_COOLDOWN_MS,
  30_000,
);

// --- Provider switching (Claude ↔ ZAI) ---
export type ProviderName = 'claude' | 'zai';

export const PROVIDER_PRIMARY: ProviderName =
  (process.env.PROVIDER_PRIMARY || envConfig.PROVIDER_PRIMARY) === 'zai'
    ? 'zai'
    : 'claude';

export const PROVIDER_FAILOVER_COOLDOWN = toNonNegativeInt(
  process.env.PROVIDER_FAILOVER_COOLDOWN ||
    envConfig.PROVIDER_FAILOVER_COOLDOWN,
  300_000, // 5 minutes
);

export const ZAI_API_KEY =
  process.env.ZAI_API_KEY || envConfig.ZAI_API_KEY || '';
export const ZAI_BASE_URL =
  process.env.ZAI_BASE_URL ||
  envConfig.ZAI_BASE_URL ||
  'https://api.z.ai/api/anthropic';
export const ZAI_DEFAULT_MODEL =
  process.env.ZAI_DEFAULT_MODEL || envConfig.ZAI_DEFAULT_MODEL || 'glm-4.5-air';
export const ZAI_DEFAULT_HAIKU_MODEL =
  process.env.ZAI_DEFAULT_HAIKU_MODEL ||
  envConfig.ZAI_DEFAULT_HAIKU_MODEL ||
  'glm-4.5-air';
export const ZAI_DEFAULT_SONNET_MODEL =
  process.env.ZAI_DEFAULT_SONNET_MODEL ||
  envConfig.ZAI_DEFAULT_SONNET_MODEL ||
  'glm-4.7';
export const ZAI_DEFAULT_OPUS_MODEL =
  process.env.ZAI_DEFAULT_OPUS_MODEL ||
  envConfig.ZAI_DEFAULT_OPUS_MODEL ||
  'glm-5';
