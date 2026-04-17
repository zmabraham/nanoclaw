import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export const CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'intercom-whitelist.json',
);

const SNAPSHOT_PATH = path.join(
  DATA_DIR,
  'ipc',
  'main',
  'intercom-whitelist-snapshot.json',
);

export interface IntercomWhitelist {
  groups: Record<
    string,
    {
      intercom: boolean;
      sync_sessions: boolean;
      auto_approved: string[];
    }
  >;
  always_ask: string[];
  expired_retention_days: number;
}

const EMPTY_WHITELIST: IntercomWhitelist = {
  groups: {},
  always_ask: [],
  expired_retention_days: 30,
};

let cached: IntercomWhitelist = EMPTY_WHITELIST;
let loaded = false;
let watching = false;

/**
 * Write a read-only snapshot of the whitelist to main's IPC directory.
 * Main reads this at `/workspace/ipc/intercom-whitelist-snapshot.json`
 * to check auto-approval without IPC round-trips.
 *
 * Uses write-to-temp-then-rename for atomicity (avoids partial reads
 * if main is mid-invocation).
 */
function writeSnapshot(whitelist: IntercomWhitelist): void {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const tempFile = `${SNAPSHOT_PATH}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(whitelist, null, 2));
    fs.renameSync(tempFile, SNAPSHOT_PATH);
    logger.debug('Whitelist snapshot written for main');
  } catch (err) {
    logger.warn(
      { err, path: SNAPSHOT_PATH },
      'Failed to write whitelist snapshot — main will fall back to asking owner for everything',
    );
  }
}

function loadConfig(): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IntercomWhitelist>;

    if (!parsed.groups || typeof parsed.groups !== 'object') {
      logger.warn(
        { path: CONFIG_PATH },
        'intercom-whitelist.json missing groups object — no groups whitelisted',
      );
      cached = EMPTY_WHITELIST;
      writeSnapshot(cached);
      return;
    }

    cached = {
      groups: parsed.groups,
      always_ask: Array.isArray(parsed.always_ask) ? parsed.always_ask : [],
      expired_retention_days:
        typeof parsed.expired_retention_days === 'number'
          ? parsed.expired_retention_days
          : 30,
    };
    logger.info(
      { count: Object.keys(cached.groups).length },
      'Loaded intercom whitelist',
    );
    writeSnapshot(cached);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn(
        { path: CONFIG_PATH },
        'intercom-whitelist.json not found — no groups whitelisted',
      );
    } else {
      logger.warn(
        { path: CONFIG_PATH, err },
        'Failed to parse intercom-whitelist.json — no groups whitelisted',
      );
    }
    cached = EMPTY_WHITELIST;
    writeSnapshot(cached);
  }
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  loadConfig();

  if (!watching) {
    watching = true;
    try {
      fs.watch(CONFIG_PATH, () => {
        logger.info('intercom-whitelist.json changed — reloading');
        loadConfig();
      });
    } catch {
      // fs.watch fails if file doesn't exist yet; fall back to polling
      try {
        fs.watchFile(CONFIG_PATH, { interval: 5000 }, () => {
          logger.info('intercom-whitelist.json changed — reloading');
          loadConfig();
        });
      } catch (err) {
        logger.warn(
          { err },
          'Failed to watch intercom-whitelist.json — using cached value',
        );
      }
    }
  }
}

/**
 * Get the current intercom whitelist.  Loads and caches on first call,
 * reloads automatically when the config file changes on disk.
 */
export function loadIntercomWhitelist(): IntercomWhitelist {
  ensureLoaded();
  return cached;
}

/**
 * Check whether a group folder is whitelisted for intercom.
 * Returns false if the config is missing or the group isn't listed (fail-closed).
 */
export function isGroupWhitelisted(groupFolder: string): boolean {
  ensureLoaded();
  return cached.groups[groupFolder]?.intercom === true;
}
