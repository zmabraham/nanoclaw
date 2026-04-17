import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'owner-identity.json',
);

let ownerSenderIds: Set<string> = new Set();
let loaded = false;
let watching = false;

interface OwnerIdentityConfig {
  sender_ids: string[];
}

function loadConfig(): void {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OwnerIdentityConfig>;

    if (!Array.isArray(parsed.sender_ids)) {
      logger.warn(
        { path: CONFIG_PATH },
        'owner-identity.json missing sender_ids array — treating all senders as member',
      );
      ownerSenderIds = new Set();
      return;
    }

    ownerSenderIds = new Set(
      parsed.sender_ids.filter(
        (id) => typeof id === 'string' && id.trim().length > 0,
      ),
    );
    logger.info(
      { count: ownerSenderIds.size },
      'Loaded owner identity sender IDs',
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.warn(
        { path: CONFIG_PATH },
        'owner-identity.json not found — treating all senders as member',
      );
    } else {
      logger.warn(
        { path: CONFIG_PATH, err },
        'Failed to parse owner-identity.json — treating all senders as member',
      );
    }
    ownerSenderIds = new Set();
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
        logger.info('owner-identity.json changed — reloading');
        loadConfig();
      });
    } catch {
      // fs.watch fails if file doesn't exist yet; fall back to polling
      try {
        fs.watchFile(CONFIG_PATH, { interval: 5000 }, () => {
          logger.info('owner-identity.json changed — reloading');
          loadConfig();
        });
      } catch (err) {
        logger.warn(
          { err },
          'Failed to watch owner-identity.json — using cached value',
        );
      }
    }
  }
}

/**
 * Check if a sender identifier matches the configured owner identity.
 * Returns false for all senders if config is missing or malformed (fail-closed).
 */
export function isOwnerSender(sender: string): boolean {
  ensureLoaded();
  return ownerSenderIds.has(sender);
}

/**
 * Verify trust level for an IPC request referencing a source message.
 * Looks up trust from the host's message store — never trusts the request payload.
 * Uses dynamic import to avoid circular dependency with db.ts.
 */
export async function verifyIpcTrust(
  sourceMessageId: string,
  requiredTier?: 'owner',
): Promise<{ valid: boolean; tier: 'owner' | 'member' | null; reason?: string }> {
  const { getMessageTrustTier } = await import('./db.js');

  const tier = getMessageTrustTier(sourceMessageId);

  if (tier === null) {
    return {
      valid: false,
      tier: null,
      reason: `source message ${sourceMessageId} not found in message store`,
    };
  }

  if (requiredTier && tier !== requiredTier) {
    return {
      valid: false,
      tier,
      reason: `trust tier '${tier}' does not meet required '${requiredTier}'`,
    };
  }

  return { valid: true, tier };
}
