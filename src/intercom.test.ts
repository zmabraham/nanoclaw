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
