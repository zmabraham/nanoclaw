import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import {
  createSyncSession,
  getActiveSession,
} from './intercom-sync.js';
import {
  atomicWriteJson,
  inboxFilename,
  safeAtomicWriteJson,
} from './intercom-utils.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Intercom message types
// ---------------------------------------------------------------------------

const CURRENT_VERSION = 1;

/** Valid message types from group outboxes */
const GROUP_MESSAGE_TYPES = new Set([
  'escalation',
  'query',
  'directive_response',
  'sync_session_request',
  'query_response',
]);

export interface IntercomMessage {
  version: number;
  id: string;
  type: string;
  from_group?: string;
  to_group?: string;
  chat_id?: string;
  source_message_id?: string;
  subject?: string;
  body?: string;
  requires_approval?: boolean;
  expects_response?: boolean;
  timeout_seconds?: number;
  expires_at?: string;
  in_response_to?: string;
  status?: string;   // 'completed' | 'error' for query_response; 'approved' | 'rejected' for approval_result
  result?: string;
  reason?: string;
  private?: boolean;
  error?: string;
  message?: string;
}

export interface IntercomDeps {
  getWhitelist: () => { expired_retention_days: number };
  verifyTrust: (
    sourceMessageId: string,
  ) => Promise<{ valid: boolean; tier: 'owner' | 'member' | null; reason?: string }>;
  isProcessed: (messageId: string) => boolean;
  markProcessed: (messageId: string) => void;
  isWhitelisted: (groupFolder: string) => boolean;
  /** Check if a group is allowed to request sync sessions. */
  isSyncSessionAllowed?: (groupFolder: string) => boolean;
  /** Invoke main container with sync session context. */
  invokeMainForSync?: (sessionId: string, socketPath: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** IPC base directory — set once at the start of processIntercomOutboxes. */
let _ipcBaseDir = '';

/** Write an error/rejection message to a group's intercom inbox. */
function writeRejection(
  inboxDir: string,
  originalId: string,
  error: string,
  message: string,
): void {
  const payload: IntercomMessage = {
    version: CURRENT_VERSION,
    id: crypto.randomUUID(),
    type: 'error',
    in_response_to: originalId,
    error,
    message,
  };
  fs.mkdirSync(inboxDir, { recursive: true });
  safeAtomicWriteJson(path.join(inboxDir, inboxFilename()), payload, _ipcBaseDir);
}

/** Move a file to a target directory, creating the directory if needed. */
function moveToDir(filePath: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });
  const dest = path.join(targetDir, path.basename(filePath));
  fs.renameSync(filePath, dest);
}

// ---------------------------------------------------------------------------
// Garbage Collection
// ---------------------------------------------------------------------------

/**
 * Move expired inbox messages to `expired/` and hard-delete old expired files.
 * Designed to run on every IPC poll cycle — only does stat/read checks.
 */
export function runIntercomGarbageCollection(
  ipcBaseDir: string,
  retentionDays: number,
  pruneProcessedTable?: () => void,
): void {
  // Prune the intercom_processed dedup table
  if (pruneProcessedTable) {
    try {
      pruneProcessedTable();
    } catch (err) {
      logger.error({ err }, 'Error pruning intercom_processed table');
    }
  }

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
      try {
        return (
          fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors'
        );
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }

  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  for (const folder of groupFolders) {
    // --- Expire inbox messages whose expires_at has passed ---
    const inboxDir = path.join(ipcBaseDir, folder, 'intercom', 'inbox');
    const expiredDir = path.join(ipcBaseDir, folder, 'intercom', 'expired');

    try {
      if (fs.existsSync(inboxDir)) {
        const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(inboxDir, file);
          try {
            const data = JSON.parse(
              fs.readFileSync(filePath, 'utf-8'),
            ) as IntercomMessage;
            if (data.expires_at) {
              const expiresAt = new Date(data.expires_at).getTime();
              if (!isNaN(expiresAt) && expiresAt < now) {
                moveToDir(filePath, expiredDir);
                logger.debug(
                  { folder, file },
                  'Moved expired intercom message to expired/',
                );
              }
            }
          } catch {
            // Skip files we can't parse — they'll be handled by the outbox
            // processor or stay until manually cleaned up.
          }
        }
      }
    } catch (err) {
      logger.error(
        { err, folder },
        'Error scanning intercom inbox for expired messages',
      );
    }

    // --- Hard-delete old expired files based on file mtime ---
    try {
      if (fs.existsSync(expiredDir)) {
        const files = fs.readdirSync(expiredDir).filter((f) => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(expiredDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > retentionMs) {
              fs.unlinkSync(filePath);
              logger.debug(
                { folder, file },
                'Hard-deleted expired intercom message past retention',
              );
            }
          } catch {
            // Ignore individual file errors
          }
        }
      }
    } catch (err) {
      logger.error(
        { err, folder },
        'Error cleaning expired intercom directory',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Outbox Processing
// ---------------------------------------------------------------------------

/**
 * Scan all group intercom outboxes, validate messages, and route them.
 * Called from the IPC watcher poll loop.
 */
export async function processIntercomOutboxes(
  ipcBaseDir: string,
  deps: IntercomDeps,
): Promise<void> {
  _ipcBaseDir = ipcBaseDir;
  let groupFolders: string[];
  try {
    const entries = await fsp.readdir(ipcBaseDir, { withFileTypes: true });
    groupFolders = entries
      .filter((e) => e.isDirectory() && e.name !== 'errors')
      .map((e) => e.name);
  } catch {
    return;
  }

  for (const folder of groupFolders) {
    const outboxDir = path.join(ipcBaseDir, folder, 'intercom', 'outbox');

    let files: string[];
    try {
      files = (await fsp.readdir(outboxDir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    const isMain = folder === 'main';
    const inboxDir = path.join(ipcBaseDir, folder, 'intercom', 'inbox');
    const errorsDir = path.join(ipcBaseDir, folder, 'intercom', 'errors');

    for (const file of files) {
      const filePath = path.join(outboxDir, file);

      // 1. Parse JSON
      let msg: IntercomMessage;
      try {
        msg = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
      } catch (err) {
        logger.warn({ folder, file, err }, 'Malformed intercom message — moving to errors/');
        moveToDir(filePath, errorsDir);
        continue;
      }

      // 2. Check version
      if (msg.version !== CURRENT_VERSION) {
        logger.warn(
          { folder, file, version: msg.version },
          'Unrecognized intercom version — rejecting',
        );
        const errorMsg = `Unrecognized version ${msg.version}. Expected ${CURRENT_VERSION}.`;
        // Write error detail to errors/ for debugging
        atomicWriteJson(
          path.join(errorsDir, `error-${path.basename(file)}`),
          {
            version: CURRENT_VERSION,
            id: crypto.randomUUID(),
            type: 'error',
            in_response_to: msg.id,
            error: 'unsupported_version',
            message: errorMsg,
          },
        );
        // Also notify the container via inbox so it gets feedback
        writeRejection(inboxDir, msg.id || 'unknown', 'unsupported_version', errorMsg);
        try { fs.unlinkSync(filePath); } catch { /* already gone */ }
        continue;
      }

      // 3. Host stamps from_group from directory path — authoritative, not container-provided
      if (!isMain) {
        msg.from_group = folder;
      }

      // 4. Validate message type (groups only — main is trusted)
      if (!isMain && !GROUP_MESSAGE_TYPES.has(msg.type)) {
        logger.warn(
          { folder, file, type: msg.type },
          'Invalid intercom message type — moving to errors/',
        );
        moveToDir(filePath, errorsDir);
        continue;
      }

      // 5. Require message ID (prevents dedup bypass)
      if (!msg.id) {
        logger.warn({ folder, file }, 'Intercom message missing id — moving to errors/');
        moveToDir(filePath, errorsDir);
        continue;
      }

      // 6. Check dedup
      if (deps.isProcessed(msg.id)) {
        logger.debug({ folder, file, id: msg.id }, 'Duplicate intercom message — skipping');
        try { fs.unlinkSync(filePath); } catch { /* already gone */ }
        continue;
      }

      // --- Route based on whether this is from main or a group ---
      if (isMain) {
        await processMainOutbox(ipcBaseDir, msg, filePath, deps);
      } else {
        await processGroupOutbox(ipcBaseDir, folder, msg, filePath, inboxDir, deps);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Group outbox processing (group → main)
// ---------------------------------------------------------------------------

async function processGroupOutbox(
  ipcBaseDir: string,
  folder: string,
  msg: IntercomMessage,
  filePath: string,
  inboxDir: string,
  deps: IntercomDeps,
): Promise<void> {
  const errorsDir = path.join(ipcBaseDir, folder, 'intercom', 'errors');

  // 5. Check whitelist
  if (!deps.isWhitelisted(folder)) {
    logger.warn({ folder, id: msg.id }, 'Intercom message from non-whitelisted group');
    writeRejection(
      inboxDir,
      msg.id,
      'group_not_whitelisted',
      `Group ${folder} is not on the intercom whitelist`,
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // query_response uses a different trust model (in_response_to instead of source_message_id)
  if (msg.type === 'query_response') {
    await handleGroupQueryResponse(ipcBaseDir, folder, msg, filePath, inboxDir, deps);
    return;
  }

  // 6. Verify trust via source_message_id
  if (!msg.source_message_id) {
    logger.warn(
      { folder, id: msg.id },
      'Intercom message missing source_message_id — rejecting',
    );
    writeRejection(
      inboxDir,
      msg.id,
      'missing_source_message_id',
      'The source_message_id field is required. Set it to the id attribute of the <message> tag ' +
      'from the user message that triggered this request.',
    );
    moveToDir(filePath, errorsDir);
    return;
  }

  const trustResult = await deps.verifyTrust(msg.source_message_id);
  if (!trustResult.valid) {
    logger.warn(
      { folder, id: msg.id, reason: trustResult.reason },
      'Intercom trust verification failed',
    );
    writeRejection(
      inboxDir,
      msg.id,
      'trust_verification_failed',
      trustResult.reason || 'Trust verification failed',
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // 7. Handle sync_session_request specially
  if (msg.type === 'sync_session_request') {
    await handleSyncSessionRequest(ipcBaseDir, folder, msg, filePath, inboxDir, deps, trustResult);
    return;
  }

  // 8. Route to main's inbox
  const mainInboxDir = path.join(ipcBaseDir, 'main', 'intercom', 'inbox');
  fs.mkdirSync(mainInboxDir, { recursive: true });
  safeAtomicWriteJson(path.join(mainInboxDir, inboxFilename()), msg, ipcBaseDir);

  // 9. Mark processed, delete original
  if (msg.id) deps.markProcessed(msg.id);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }

  logger.info(
    { folder, id: msg.id, type: msg.type },
    'Intercom message routed to main inbox',
  );
}

// ---------------------------------------------------------------------------
// Sync session request handling (group → host-brokered session)
// ---------------------------------------------------------------------------

async function handleSyncSessionRequest(
  ipcBaseDir: string,
  folder: string,
  msg: IntercomMessage,
  filePath: string,
  inboxDir: string,
  deps: IntercomDeps,
  trustResult: { valid: boolean; tier: 'owner' | 'member' | null },
): Promise<void> {
  // 1. Require owner trust
  if (trustResult.tier !== 'owner') {
    logger.warn(
      { folder, id: msg.id, tier: trustResult.tier },
      'Sync session request requires owner trust',
    );
    writeRejection(
      inboxDir,
      msg.id,
      'owner_trust_required',
      'Sync sessions require owner trust. The source message must be from the owner.',
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // 2. Check sync_sessions whitelist permission
  if (deps.isSyncSessionAllowed && !deps.isSyncSessionAllowed(folder)) {
    logger.warn(
      { folder, id: msg.id },
      'Group not allowed for sync sessions',
    );
    writeRejection(
      inboxDir,
      msg.id,
      'sync_sessions_not_allowed',
      `Group ${folder} does not have sync_sessions enabled in the whitelist`,
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // 3. Check no active session for this group
  if (getActiveSession(folder)) {
    logger.warn(
      { folder, id: msg.id },
      'Sync session already active for group',
    );
    writeRejection(
      inboxDir,
      msg.id,
      'session_already_active',
      `A sync session is already active for group ${folder}. Only one session per group is allowed.`,
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // 4. Create the sync session
  const timeoutSeconds = msg.timeout_seconds ?? 120;
  const session = createSyncSession(ipcBaseDir, folder, timeoutSeconds);

  // 5. Write sync_session_ready to group's inbox
  fs.mkdirSync(inboxDir, { recursive: true });
  atomicWriteJson(path.join(inboxDir, inboxFilename()), {
    type: 'sync_session_ready',
    session_id: session.id,
    socket_path: `/workspace/ipc/intercom/session-${session.id}.sock`,
  });

  // 6. Invoke main with session context
  if (deps.invokeMainForSync) {
    const mainSocketContainerPath = `/workspace/ipc/intercom/session-${session.id}.sock`;
    deps.invokeMainForSync(session.id, mainSocketContainerPath);
  }

  // Mark processed, delete original
  if (msg.id) deps.markProcessed(msg.id);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }

  logger.info(
    { folder, id: msg.id, sessionId: session.id },
    'Sync session created and ready notification sent',
  );
}

// ---------------------------------------------------------------------------
// Group query_response handling (group → reply to main's query)
// ---------------------------------------------------------------------------

async function handleGroupQueryResponse(
  ipcBaseDir: string,
  folder: string,
  msg: IntercomMessage,
  filePath: string,
  inboxDir: string,
  deps: IntercomDeps,
): Promise<void> {
  const errorsDir = path.join(ipcBaseDir, folder, 'intercom', 'errors');

  // 1. Require in_response_to — malformed; move to errors/ (no feedback path, can't reply)
  if (!msg.in_response_to) {
    logger.warn({ folder, id: msg.id }, 'query_response missing in_response_to — moving to errors/');
    moveToDir(filePath, errorsDir);
    return;
  }

  // 2. Require valid status — defense against hand-crafted outbox files
  if (msg.status !== 'completed' && msg.status !== 'error') {
    logger.warn(
      { folder, id: msg.id, status: msg.status },
      'query_response has invalid or missing status — moving to errors/',
    );
    moveToDir(filePath, errorsDir);
    return;
  }

  // 3. Validate in_response_to against intercom_processed (trust basis for responses)
  //    intercom_processed is populated when the host delivers a message, so a processed
  //    in_response_to proves the group is replying to a real delivered query.
  if (!deps.isProcessed(msg.in_response_to)) {
    logger.warn(
      { folder, id: msg.id, in_response_to: msg.in_response_to },
      'query_response references unknown query — rejecting to sender inbox',
    );
    writeRejection(
      inboxDir,
      msg.id,
      'unknown_query_reference',
      `The referenced query ID ${msg.in_response_to} was not found in the host's processed-messages ` +
      `table. It may have never existed or expired (retention: ${deps.getWhitelist().expired_retention_days} days).`,
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // 4. Resolve target; reject self-routing (would cause an inbox re-invocation loop)
  const target = msg.to_group ?? 'main';
  if (target === folder) {
    logger.warn({ folder, id: msg.id }, 'query_response targets sender own inbox — rejecting');
    writeRejection(
      inboxDir,
      msg.id,
      'self_routing_rejected',
      'The to_group field must not equal the sending group folder.',
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // 5. Validate target whitelist — skip for 'main' (always a valid target)
  if (target !== 'main' && !deps.isWhitelisted(target)) {
    logger.warn({ folder, id: msg.id, target }, 'query_response target not whitelisted — rejecting');
    writeRejection(
      inboxDir,
      msg.id,
      'target_not_whitelisted',
      `Target group ${target} is not on the intercom whitelist`,
    );
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }
    return;
  }

  // 6. Route to target inbox
  const targetInboxDir = path.join(ipcBaseDir, target, 'intercom', 'inbox');
  fs.mkdirSync(targetInboxDir, { recursive: true });
  safeAtomicWriteJson(path.join(targetInboxDir, inboxFilename()), msg, ipcBaseDir);

  // 7. Mark processed, delete original
  if (msg.id) deps.markProcessed(msg.id);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }

  logger.info(
    { folder, id: msg.id, target, in_response_to: msg.in_response_to },
    'query_response routed to target inbox',
  );
}

// ---------------------------------------------------------------------------
// Main outbox processing (main → group)
// ---------------------------------------------------------------------------

async function processMainOutbox(
  ipcBaseDir: string,
  msg: IntercomMessage,
  filePath: string,
  deps: IntercomDeps,
): Promise<void> {
  const mainInboxDir = path.join(ipcBaseDir, 'main', 'intercom', 'inbox');

  if (msg.to_group) {
    // Directive / targeted message from main to a specific group
    if (!deps.isWhitelisted(msg.to_group)) {
      logger.warn(
        { to_group: msg.to_group, id: msg.id },
        'Main directive target not whitelisted',
      );
      writeRejection(
        mainInboxDir,
        msg.id,
        'target_not_whitelisted',
        `Target group ${msg.to_group} is not on the intercom whitelist`,
      );
      try { fs.unlinkSync(filePath); } catch { /* already gone */ }
      return;
    }

    const targetInboxDir = path.join(
      ipcBaseDir,
      msg.to_group,
      'intercom',
      'inbox',
    );
    fs.mkdirSync(targetInboxDir, { recursive: true });
    safeAtomicWriteJson(path.join(targetInboxDir, inboxFilename()), msg, ipcBaseDir);

    if (msg.id) deps.markProcessed(msg.id);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }

    logger.info(
      { to_group: msg.to_group, id: msg.id, type: msg.type },
      'Main directive delivered to group inbox',
    );
  } else if (msg.in_response_to) {
    // Response from main — route back to originating group.
    // Prefer to_group (explicit target); fall back to from_group for compatibility.
    const targetGroup = msg.to_group || msg.from_group;
    if (!targetGroup) {
      logger.warn(
        { id: msg.id },
        'Main response missing from_group (target) — moving to errors/',
      );
      moveToDir(
        filePath,
        path.join(ipcBaseDir, 'main', 'intercom', 'errors'),
      );
      return;
    }

    const targetInboxDir = path.join(
      ipcBaseDir,
      targetGroup,
      'intercom',
      'inbox',
    );
    fs.mkdirSync(targetInboxDir, { recursive: true });
    safeAtomicWriteJson(path.join(targetInboxDir, inboxFilename()), msg, ipcBaseDir);

    if (msg.id) deps.markProcessed(msg.id);
    try { fs.unlinkSync(filePath); } catch { /* already gone */ }

    logger.info(
      { targetGroup, id: msg.id, type: msg.type },
      'Main response delivered to group inbox',
    );
  } else {
    // Main message with no target and no response context — error
    logger.warn(
      { id: msg.id },
      'Main outbox message has no to_group and no in_response_to — moving to errors/',
    );
    moveToDir(filePath, path.join(ipcBaseDir, 'main', 'intercom', 'errors'));
  }
}

// ---------------------------------------------------------------------------
// Inbox Pending Detection
// ---------------------------------------------------------------------------

/** Cache of directory mtime → file count to avoid re-scanning unchanged dirs. */
const inboxCountCache = new Map<string, { mtimeMs: number; count: number }>();

/**
 * Count non-expired `.json` files in a group's intercom inbox directory.
 * Returns 0 if the directory doesn't exist.  Uses directory mtime caching
 * to skip re-scanning unchanged directories on every poll cycle.
 * On cache miss, parses each file's `expires_at` to filter out expired messages.
 *
 * _Requirements: 1.1, 1.2_
 */
export function getIntercomPendingCount(groupInboxDir: string): number {
  try {
    const dirStat = fs.statSync(groupInboxDir);
    const cached = inboxCountCache.get(groupInboxDir);
    if (cached && cached.mtimeMs === dirStat.mtimeMs) {
      return cached.count;
    }

    const now = Date.now();
    let count = 0;
    for (const f of fs.readdirSync(groupInboxDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(groupInboxDir, f), 'utf-8'));
        if (data.expires_at) {
          const exp = new Date(data.expires_at).getTime();
          if (!isNaN(exp) && exp < now) continue;
        }
        count++;
      } catch {
        // Unparseable files still count — they won't be GC'd by expiry
        count++;
      }
    }
    inboxCountCache.set(groupInboxDir, { mtimeMs: dirStat.mtimeMs, count });
    return count;
  } catch {
    // Directory doesn't exist or unreadable
    inboxCountCache.delete(groupInboxDir);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Debounced Inbox-Triggered Invocation
// ---------------------------------------------------------------------------

/** Per-group debounce timers for inbox-triggered invocations. */
const pendingInvocations = new Map<string, NodeJS.Timeout>();

const INBOX_DEBOUNCE_MS = 5_000;

/**
 * Scan all groups for pending intercom inbox messages and trigger debounced
 * container invocations for cold groups (no running container).
 *
 * Called from the IPC watcher poll loop.  Skips the "main" group — main is
 * invoked via different mechanisms.
 *
 * _Requirements: 1.3, 2.1, 2.2, 2.3_
 */
export function checkAndTriggerInboxInvocations(
  ipcBaseDir: string,
  isContainerRunning: (groupFolder: string) => boolean,
  enqueueInvocation: (groupFolder: string, pendingCount: number) => void,
  notifyIdleContainer?: (groupFolder: string, pendingCount: number) => boolean,
): void {
  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
      try {
        return (
          fs.statSync(path.join(ipcBaseDir, f)).isDirectory() &&
          f !== 'errors'
        );
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }

  for (const folder of groupFolders) {
    const inboxDir = path.join(ipcBaseDir, folder, 'intercom', 'inbox');
    const pendingCount = getIntercomPendingCount(inboxDir);

    if (pendingCount === 0) continue;
    if (isContainerRunning(folder)) {
      // If a container is idle-waiting, pipe a notification to it
      if (notifyIdleContainer) {
        notifyIdleContainer(folder, pendingCount);
      }
      continue;
    }
    if (pendingInvocations.has(folder)) continue; // Debounce already running — don't reset

    const timer = setTimeout(() => {
      pendingInvocations.delete(folder);
      // Re-check: container may have started during the debounce window
      if (isContainerRunning(folder)) {
        logger.debug(
          { folder },
          'Inbox invocation debounce fired but container is now running — skipping',
        );
        return;
      }
      // Re-count: some messages may have been picked up opportunistically
      const currentCount = getIntercomPendingCount(inboxDir);
      if (currentCount === 0) {
        logger.debug(
          { folder },
          'Inbox invocation debounce fired but inbox is now empty — skipping',
        );
        return;
      }
      logger.info(
        { folder, pendingCount: currentCount },
        'Triggering intercom inbox invocation',
      );
      enqueueInvocation(folder, currentCount);
    }, INBOX_DEBOUNCE_MS);

    pendingInvocations.set(folder, timer);
    logger.debug(
      { folder, pendingCount },
      'Started inbox invocation debounce timer',
    );
  }
}

/** Clear all pending debounce timers (for clean shutdown). */
export function clearPendingInboxInvocations(): void {
  for (const timer of pendingInvocations.values()) {
    clearTimeout(timer);
  }
  pendingInvocations.clear();
}
