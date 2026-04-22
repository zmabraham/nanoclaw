import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { processIntercomOutboxes } from './intercom.js';
import type { IntercomDeps } from './intercom.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<IntercomDeps> = {}): IntercomDeps {
  return {
    getWhitelist: () => ({ expired_retention_days: 30 }),
    verifyTrust: async () => ({ valid: true, tier: 'owner' as const }),
    isProcessed: () => false,
    markProcessed: vi.fn(),
    isWhitelisted: () => true,
    ...overrides,
  };
}

function writeOutbox(ipcDir: string, folder: string, msg: object): void {
  const dir = path.join(ipcDir, folder, 'intercom', 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    JSON.stringify(msg),
  );
}

function listInbox(ipcDir: string, folder: string): object[] {
  const dir = path.join(ipcDir, folder, 'intercom', 'inbox');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
  } catch {
    return [];
  }
}

function listErrors(ipcDir: string, folder: string): string[] {
  const dir = path.join(ipcDir, folder, 'intercom', 'errors');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercom-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('missing source_message_id feedback', () => {
  it('writes rejection to sender inbox when source_message_id is missing', async () => {
    writeOutbox(tmpDir, 'group-a', {
      version: 1,
      id: 'msg-no-src',
      type: 'escalation',
      subject: 'test',
      body: 'test',
    });
    await processIntercomOutboxes(tmpDir, makeDeps());
    const senderInbox = listInbox(tmpDir, 'group-a');
    expect(senderInbox).toHaveLength(1);
    expect(senderInbox[0]).toMatchObject({
      type: 'error',
      error: 'missing_source_message_id',
    });
    // Also moved to errors/
    expect(listErrors(tmpDir, 'group-a')).toHaveLength(1);
    // Not routed to main
    expect(listInbox(tmpDir, 'main')).toHaveLength(0);
  });
});

describe('GROUP_MESSAGE_TYPES gate', () => {
  it('rejects unknown message type from group (existing behaviour)', async () => {
    writeOutbox(tmpDir, 'group-a', {
      version: 1,
      id: 'msg-unknown',
      type: 'not_a_real_type',
      source_message_id: 'src-1',
    });
    await processIntercomOutboxes(tmpDir, makeDeps());
    expect(listErrors(tmpDir, 'group-a')).toHaveLength(1);
    expect(listInbox(tmpDir, 'main')).toHaveLength(0);
  });
});

describe('handleGroupQueryResponse', () => {
  const knownQueryId = 'known-query-uuid';

  // isProcessed: true for the original query id (trust check passes),
  //              false for the response's own id (outer dedup passes).
  function makeDepsWithKnown(extra: Partial<IntercomDeps> = {}): IntercomDeps {
    return makeDeps({
      isProcessed: (id: string) => id === knownQueryId,
      ...extra,
    });
  }

  function validResponse(overrides: object = {}): object {
    return {
      version: 1,
      id: 'response-uuid',
      type: 'query_response',
      in_response_to: knownQueryId,
      status: 'completed',
      result: 'the answer',
      ...overrides,
    };
  }

  it('routes a valid query_response to main inbox', async () => {
    writeOutbox(tmpDir, 'group-a', validResponse());
    await processIntercomOutboxes(tmpDir, makeDepsWithKnown());
    const mainInbox = listInbox(tmpDir, 'main');
    expect(mainInbox).toHaveLength(1);
    expect(mainInbox[0]).toMatchObject({
      type: 'query_response',
      from_group: 'group-a',
      in_response_to: knownQueryId,
      status: 'completed',
      result: 'the answer',
    });
  });

  it('moves to errors/ when in_response_to is missing', async () => {
    writeOutbox(tmpDir, 'group-a', {
      version: 1,
      id: 'r1',
      type: 'query_response',
      status: 'completed',
    });
    await processIntercomOutboxes(tmpDir, makeDepsWithKnown());
    expect(listErrors(tmpDir, 'group-a')).toHaveLength(1);
    expect(listInbox(tmpDir, 'main')).toHaveLength(0);
  });

  it('moves to errors/ when status is missing', async () => {
    writeOutbox(tmpDir, 'group-a', {
      version: 1,
      id: 'r2',
      type: 'query_response',
      in_response_to: knownQueryId,
    });
    await processIntercomOutboxes(tmpDir, makeDepsWithKnown());
    expect(listErrors(tmpDir, 'group-a')).toHaveLength(1);
  });

  it('moves to errors/ when status is an invalid value', async () => {
    writeOutbox(tmpDir, 'group-a', validResponse({ status: 'approved' }));
    await processIntercomOutboxes(tmpDir, makeDepsWithKnown());
    expect(listErrors(tmpDir, 'group-a')).toHaveLength(1);
  });

  it('writes unknown_query_reference rejection to sender inbox when in_response_to is not processed', async () => {
    writeOutbox(
      tmpDir,
      'group-a',
      validResponse({ in_response_to: 'unrecognized-id' }),
    );
    await processIntercomOutboxes(tmpDir, makeDepsWithKnown());
    const senderInbox = listInbox(tmpDir, 'group-a');
    expect(senderInbox).toHaveLength(1);
    expect(senderInbox[0]).toMatchObject({
      type: 'error',
      error: 'unknown_query_reference',
    });
    expect(listInbox(tmpDir, 'main')).toHaveLength(0);
  });

  it('rejects self-routing (to_group equals sender folder)', async () => {
    writeOutbox(tmpDir, 'group-a', validResponse({ to_group: 'group-a' }));
    await processIntercomOutboxes(tmpDir, makeDepsWithKnown());
    const senderInbox = listInbox(tmpDir, 'group-a');
    expect(senderInbox).toHaveLength(1);
    expect(senderInbox[0]).toMatchObject({
      type: 'error',
      error: 'self_routing_rejected',
    });
    expect(listInbox(tmpDir, 'main')).toHaveLength(0);
  });

  it('skips target whitelist check when routing to main', async () => {
    const isWhitelisted = vi.fn(() => true);
    writeOutbox(tmpDir, 'group-a', validResponse()); // no to_group → defaults to 'main'
    await processIntercomOutboxes(tmpDir, {
      ...makeDepsWithKnown(),
      isWhitelisted,
    });
    const mainCalls = (isWhitelisted.mock.calls as string[][]).filter(
      (args) => args[0] === 'main',
    );
    expect(mainCalls).toHaveLength(0);
    expect(listInbox(tmpDir, 'main')).toHaveLength(1);
  });

  it('rejects non-main to_group that is not whitelisted', async () => {
    writeOutbox(tmpDir, 'group-a', validResponse({ to_group: 'group-b' }));
    const deps = makeDepsWithKnown({
      isWhitelisted: (g: string) => g !== 'group-b',
    });
    await processIntercomOutboxes(tmpDir, deps);
    const senderInbox = listInbox(tmpDir, 'group-a');
    expect(senderInbox).toHaveLength(1);
    expect(senderInbox[0]).toMatchObject({
      type: 'error',
      error: 'target_not_whitelisted',
    });
    expect(listInbox(tmpDir, 'group-b')).toHaveLength(0);
  });

  it('marks the response id as processed after routing', async () => {
    const markProcessed = vi.fn();
    writeOutbox(tmpDir, 'group-a', validResponse());
    await processIntercomOutboxes(tmpDir, makeDepsWithKnown({ markProcessed }));
    expect(markProcessed).toHaveBeenCalledWith('response-uuid');
  });
});

// ---------------------------------------------------------------------------
// verifyTrust rejection path — trust check applies to escalation, query,
// directive_response (and, indirectly, to sync_session_request before it
// branches). A failed verification must produce a 'trust_verification_failed'
// rejection in the sender's inbox and NOT route to main.
// ---------------------------------------------------------------------------

describe('verifyTrust rejection path', () => {
  for (const type of ['escalation', 'query', 'directive_response']) {
    it(`rejects ${type} when verifyTrust returns invalid`, async () => {
      writeOutbox(tmpDir, 'group-a', {
        version: 1,
        id: `msg-${type}`,
        type,
        source_message_id: 'src-1',
        subject: 'x',
        body: 'y',
      });
      await processIntercomOutboxes(
        tmpDir,
        makeDeps({
          verifyTrust: async () => ({
            valid: false,
            tier: null,
            reason: 'no trust',
          }),
        }),
      );
      const senderInbox = listInbox(tmpDir, 'group-a') as Array<{
        type: string;
        error: string;
      }>;
      expect(senderInbox).toHaveLength(1);
      expect(senderInbox[0]).toMatchObject({
        type: 'error',
        error: 'trust_verification_failed',
      });
      expect(listInbox(tmpDir, 'main')).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// sync_session_request gating — requires owner trust AND sync_sessions
// permission on the source group.
// ---------------------------------------------------------------------------

describe('sync_session_request gating', () => {
  it('rejects sync_session_request when trust tier is member (not owner)', async () => {
    writeOutbox(tmpDir, 'group-a', {
      version: 1,
      id: 'sync-1',
      type: 'sync_session_request',
      source_message_id: 'src-1',
      timeout_seconds: 30,
    });
    await processIntercomOutboxes(
      tmpDir,
      makeDeps({
        verifyTrust: async () => ({
          valid: true,
          tier: 'member' as const,
        }),
      }),
    );
    const senderInbox = listInbox(tmpDir, 'group-a') as Array<{
      type: string;
      error: string;
    }>;
    expect(senderInbox).toHaveLength(1);
    expect(senderInbox[0]).toMatchObject({
      type: 'error',
      error: 'owner_trust_required',
    });
  });

  it('rejects sync_session_request when sync_sessions not allowed for group', async () => {
    writeOutbox(tmpDir, 'group-a', {
      version: 1,
      id: 'sync-2',
      type: 'sync_session_request',
      source_message_id: 'src-1',
    });
    await processIntercomOutboxes(
      tmpDir,
      makeDeps({
        isSyncSessionAllowed: (g: string) => g !== 'group-a',
      }),
    );
    const senderInbox = listInbox(tmpDir, 'group-a') as Array<{
      type: string;
      error: string;
    }>;
    expect(senderInbox).toHaveLength(1);
    expect(senderInbox[0]).toMatchObject({
      type: 'error',
      error: 'sync_sessions_not_allowed',
    });
  });
});

// ---------------------------------------------------------------------------
// Dedup short-circuit — if the outer message id is already marked processed,
// the file is deleted from the outbox without re-routing.
// ---------------------------------------------------------------------------

describe('dedup short-circuit', () => {
  it('deletes the outbox file without routing when id is already processed', async () => {
    writeOutbox(tmpDir, 'group-a', {
      version: 1,
      id: 'dup-1',
      type: 'escalation',
      source_message_id: 'src-1',
      subject: 'x',
      body: 'y',
    });
    await processIntercomOutboxes(
      tmpDir,
      makeDeps({
        isProcessed: (id: string) => id === 'dup-1',
      }),
    );
    const outboxDir = path.join(tmpDir, 'group-a', 'intercom', 'outbox');
    // Outbox file removed
    const leftover = fs.existsSync(outboxDir)
      ? fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(leftover).toHaveLength(0);
    // Not routed to main, no rejection to sender
    expect(listInbox(tmpDir, 'main')).toHaveLength(0);
    expect(listInbox(tmpDir, 'group-a')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Symlink escape — assertWithinBase must refuse writes that resolve outside
// the ipcBaseDir via a symlinked inbox.
// ---------------------------------------------------------------------------

describe('safeAtomicWriteJson symlink escape', () => {
  it('blocks writes when inbox is replaced by a symlink to an outside dir', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      // Pre-create the outbox, then replace inbox/ with a symlink to outside
      fs.mkdirSync(path.join(tmpDir, 'group-a', 'intercom', 'outbox'), {
        recursive: true,
      });
      fs.symlinkSync(
        outsideDir,
        path.join(tmpDir, 'group-a', 'intercom', 'inbox'),
      );
      // Write a message that will produce a rejection (invalid type →
      // also writes to errorsDir inside the ipcBaseDir, which is fine).
      // Missing source_message_id triggers writeRejection → would write
      // into group-a/intercom/inbox — the symlinked escape path.
      writeOutbox(tmpDir, 'group-a', {
        version: 1,
        id: 'esc-1',
        type: 'escalation',
        subject: 'x',
        body: 'y',
      });
      // assertWithinBase throws synchronously — catch it so the test
      // can observe that nothing was written. Real callers currently
      // let this propagate; what matters is that the symlinked path
      // never receives data.
      await expect(processIntercomOutboxes(tmpDir, makeDeps())).rejects.toThrow(
        /Path traversal blocked/,
      );
      const outsideFiles = fs.readdirSync(outsideDir);
      expect(outsideFiles).toHaveLength(0);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
