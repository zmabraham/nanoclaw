import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { inboxFilename, safeAtomicWriteJson } from './intercom-utils.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncSessionProxy {
  groupServer: net.Server;
  mainServer: net.Server;
  groupConn: net.Socket | null;
  mainConn: net.Socket | null;
}

export interface SyncSession {
  id: string;
  ipcBaseDir: string;
  groupFolder: string;
  groupSocketPath: string;
  mainSocketPath: string;
  groupInboxDir: string;
  mainInboxDir: string;
  proxy: SyncSessionProxy;
  timeout: NodeJS.Timeout;
  transcript: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Session store (in-memory, one per group at a time)
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, SyncSession>();

/** Map from session ID to group folder for reverse lookup. */
const sessionIdToGroup = new Map<string, string>();

// ---------------------------------------------------------------------------
// Session Manager (Task 1)
// ---------------------------------------------------------------------------

/**
 * Create a sync session between a group container and main.
 * Sets up socket paths, starts proxy servers, and arms the timeout.
 */
export function createSyncSession(
  ipcBaseDir: string,
  groupFolder: string,
  timeoutSeconds: number = 120,
): SyncSession {
  const sessionId = crypto.randomUUID();

  // Socket paths under per-group IPC directories
  const groupSocketDir = path.join(ipcBaseDir, groupFolder, 'intercom');
  const mainSocketDir = path.join(ipcBaseDir, 'main', 'intercom');
  fs.mkdirSync(groupSocketDir, { recursive: true });
  fs.mkdirSync(mainSocketDir, { recursive: true });

  const groupSocketPath = path.join(
    groupSocketDir,
    `session-${sessionId}.sock`,
  );
  const mainSocketPath = path.join(mainSocketDir, `session-${sessionId}.sock`);

  // Clean up any leftover sockets at these paths
  for (const p of [groupSocketPath, mainSocketPath]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* not present */
    }
  }

  // Create proxy servers (Task 2 — proxy bridging).
  // Safe to call before populating activeSessions / sessionIdToGroup:
  // net.Server defers 'connection' events to the next tick, so the
  // session registration below runs first in the current tick.
  // Don't refactor createSyncSession to be async without moving this
  // registration ahead of createProxy.
  const proxy = createProxy(sessionId, groupSocketPath, mainSocketPath);

  // Arm timeout
  const timeout = setTimeout(() => {
    terminateSession(sessionId, 'timeout');
  }, timeoutSeconds * 1000);
  timeout.unref();

  const session: SyncSession = {
    id: sessionId,
    ipcBaseDir,
    groupFolder,
    groupSocketPath,
    mainSocketPath,
    groupInboxDir: path.join(ipcBaseDir, groupFolder, 'intercom', 'inbox'),
    mainInboxDir: path.join(ipcBaseDir, 'main', 'intercom', 'inbox'),
    proxy,
    timeout,
    transcript: [],
    createdAt: Date.now(),
  };

  activeSessions.set(groupFolder, session);
  sessionIdToGroup.set(sessionId, groupFolder);

  logger.info(
    {
      sessionId,
      groupFolder,
      groupSocketPath,
      mainSocketPath,
      timeoutSeconds,
    },
    'Sync session created',
  );

  return session;
}

/**
 * Terminate a sync session by ID.
 * Kills proxy, removes sockets, writes session_terminated + transcript.
 */
export function terminateSession(sessionId: string, reason: string): void {
  const groupFolder = sessionIdToGroup.get(sessionId);
  if (!groupFolder) {
    logger.debug({ sessionId }, 'terminateSession: session not found');
    return;
  }

  const session = activeSessions.get(groupFolder);
  if (!session || session.id !== sessionId) {
    logger.debug(
      { sessionId, groupFolder },
      'terminateSession: session mismatch',
    );
    return;
  }

  logger.info({ sessionId, groupFolder, reason }, 'Terminating sync session');

  // Clear timeout
  clearTimeout(session.timeout);

  // Close connections and servers
  const { proxy } = session;
  try {
    proxy.groupConn?.destroy();
  } catch {
    /* ignore */
  }
  try {
    proxy.mainConn?.destroy();
  } catch {
    /* ignore */
  }
  try {
    proxy.groupServer.close();
  } catch {
    /* ignore */
  }
  try {
    proxy.mainServer.close();
  } catch {
    /* ignore */
  }

  // Remove socket files
  for (const p of [session.groupSocketPath, session.mainSocketPath]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }

  // Write transcript to group's inbox
  fs.mkdirSync(session.groupInboxDir, { recursive: true });
  const transcriptFilename = `${Date.now()}-${sessionId}.json`;
  const transcriptPath = path.join(session.groupInboxDir, transcriptFilename);
  safeAtomicWriteJson(
    transcriptPath,
    {
      type: 'session_transcript',
      session_id: sessionId,
      lines: session.transcript,
      terminated_at: new Date().toISOString(),
      reason,
    },
    session.ipcBaseDir,
  );

  // Write session_terminated to group inbox
  safeAtomicWriteJson(
    path.join(session.groupInboxDir, inboxFilename()),
    {
      type: 'session_terminated',
      session_id: sessionId,
      reason,
      transcript_file: transcriptFilename,
    },
    session.ipcBaseDir,
  );

  // Write session_terminated to main inbox (no transcript_file — main
  // can't read the group's inbox where the transcript lives)
  fs.mkdirSync(session.mainInboxDir, { recursive: true });
  safeAtomicWriteJson(
    path.join(session.mainInboxDir, inboxFilename()),
    {
      type: 'session_terminated',
      session_id: sessionId,
      reason,
    },
    session.ipcBaseDir,
  );

  // Remove from stores
  activeSessions.delete(groupFolder);
  sessionIdToGroup.delete(sessionId);
}

/**
 * Get the active sync session for a group, or null if none.
 */
export function getActiveSession(groupFolder: string): SyncSession | null {
  return activeSessions.get(groupFolder) ?? null;
}

/**
 * Remove stale session sockets on startup.
 * Scans each group's intercom directory for session-{id}.sock files and deletes them.
 */
export function cleanupStaleSessions(ipcBaseDir: string): void {
  const staleFiles: string[] = [];

  try {
    const groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
      try {
        return fs.statSync(path.join(ipcBaseDir, f)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const folder of groupFolders) {
      const intercomDir = path.join(ipcBaseDir, folder, 'intercom');
      try {
        const files = fs.readdirSync(intercomDir);
        for (const file of files) {
          if (file.startsWith('session-') && file.endsWith('.sock')) {
            staleFiles.push(path.join(intercomDir, file));
          }
        }
      } catch {
        /* directory doesn't exist — skip */
      }
    }
  } catch {
    /* ipcBaseDir doesn't exist — nothing to clean */
    return;
  }

  if (staleFiles.length === 0) return;

  for (const file of staleFiles) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  logger.info(
    { count: staleFiles.length },
    'Cleaned up stale sync session sockets',
  );
}

// ---------------------------------------------------------------------------
// Socket Proxy Bridging (Task 2)
// ---------------------------------------------------------------------------

/**
 * Create two net.Server instances (one per socket path) that bridge data
 * line-by-line between the group container and main container.
 */
function createProxy(
  sessionId: string,
  groupSocketPath: string,
  mainSocketPath: string,
): SyncSessionProxy {
  const state: SyncSessionProxy = {
    groupServer: null!,
    mainServer: null!,
    groupConn: null,
    mainConn: null,
  };

  // Buffers for line-by-line parsing (newline-delimited JSON)
  let groupBuffer = '';
  let mainBuffer = '';
  let terminated = false;

  // Max buffer size (1MB) — if a container streams data without newlines,
  // the buffer would grow indefinitely. Cap it to prevent OOM.
  const MAX_BUFFER_SIZE = 1024 * 1024;

  const tryTerminate = (reason: string) => {
    if (terminated) return;
    terminated = true;
    terminateSession(sessionId, reason);
  };

  // --- Group-side server ---
  state.groupServer = net.createServer((conn) => {
    if (state.groupConn) {
      // Only one connection allowed
      conn.destroy();
      return;
    }
    state.groupConn = conn;
    logger.debug({ sessionId }, 'Group container connected to sync session');

    conn.on('data', (chunk) => {
      groupBuffer += chunk.toString();
      if (groupBuffer.length > MAX_BUFFER_SIZE && !groupBuffer.includes('\n')) {
        logger.warn(
          { sessionId, bufferSize: groupBuffer.length },
          'Group buffer exceeded max size without newline',
        );
        tryTerminate('proxy_error');
        return;
      }
      let newlineIdx: number;
      while ((newlineIdx = groupBuffer.indexOf('\n')) !== -1) {
        const line = groupBuffer.slice(0, newlineIdx);
        groupBuffer = groupBuffer.slice(newlineIdx + 1);
        if (line.trim().length === 0) continue;

        // Get the session to accumulate transcript
        const session = activeSessions.get(
          sessionIdToGroup.get(sessionId) ?? '',
        );
        if (session) {
          session.transcript.push(`group: ${line}`);
        }

        // Inspect type field
        try {
          const parsed = JSON.parse(line);
          logger.debug(
            { sessionId, direction: 'group→main', type: parsed.type },
            'Sync session message',
          );
          if (parsed.type === 'session_end') {
            tryTerminate('graceful_close');
            return;
          }
        } catch {
          logger.debug(
            { sessionId, direction: 'group→main' },
            'Sync session non-JSON line',
          );
        }

        // Forward to main (backpressure: pause source if drain needed)
        if (state.mainConn && !state.mainConn.destroyed) {
          const ok = state.mainConn.write(line + '\n');
          if (!ok && state.groupConn) {
            state.groupConn.pause();
            state.mainConn.once('drain', () => state.groupConn?.resume());
          }
        }
      }
    });

    conn.on('close', () => {
      state.groupConn = null;
      tryTerminate('connection_lost');
    });

    conn.on('error', (err) => {
      logger.error({ sessionId, err }, 'Group socket error');
      tryTerminate('proxy_error');
    });
  });

  state.groupServer.on('error', (err) => {
    logger.error({ sessionId, err }, 'Group server error');
    tryTerminate('proxy_error');
  });

  state.groupServer.listen(groupSocketPath);

  // --- Main-side server ---
  state.mainServer = net.createServer((conn) => {
    if (state.mainConn) {
      conn.destroy();
      return;
    }
    state.mainConn = conn;
    logger.debug({ sessionId }, 'Main container connected to sync session');

    conn.on('data', (chunk) => {
      mainBuffer += chunk.toString();
      if (mainBuffer.length > MAX_BUFFER_SIZE && !mainBuffer.includes('\n')) {
        logger.warn(
          { sessionId, bufferSize: mainBuffer.length },
          'Main buffer exceeded max size without newline',
        );
        tryTerminate('proxy_error');
        return;
      }
      let newlineIdx: number;
      while ((newlineIdx = mainBuffer.indexOf('\n')) !== -1) {
        const line = mainBuffer.slice(0, newlineIdx);
        mainBuffer = mainBuffer.slice(newlineIdx + 1);
        if (line.trim().length === 0) continue;

        const session = activeSessions.get(
          sessionIdToGroup.get(sessionId) ?? '',
        );
        if (session) {
          session.transcript.push(`main: ${line}`);
        }

        try {
          const parsed = JSON.parse(line);
          logger.debug(
            { sessionId, direction: 'main→group', type: parsed.type },
            'Sync session message',
          );
          if (parsed.type === 'session_end') {
            tryTerminate('graceful_close');
            return;
          }
        } catch {
          logger.debug(
            { sessionId, direction: 'main→group' },
            'Sync session non-JSON line',
          );
        }

        // Forward to group (backpressure: pause source if drain needed)
        if (state.groupConn && !state.groupConn.destroyed) {
          const ok = state.groupConn.write(line + '\n');
          if (!ok && state.mainConn) {
            state.mainConn.pause();
            state.groupConn.once('drain', () => state.mainConn?.resume());
          }
        }
      }
    });

    conn.on('close', () => {
      state.mainConn = null;
      tryTerminate('connection_lost');
    });

    conn.on('error', (err) => {
      logger.error({ sessionId, err }, 'Main socket error');
      tryTerminate('proxy_error');
    });
  });

  state.mainServer.on('error', (err) => {
    logger.error({ sessionId, err }, 'Main server error');
    tryTerminate('proxy_error');
  });

  state.mainServer.listen(mainSocketPath);

  return state;
}
