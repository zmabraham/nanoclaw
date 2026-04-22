import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import after mock so the module picks up the mocked logger.
import { parseMediaReferences } from './marker-parser.js';
import { MEDIA_MAX_AGGREGATE_BYTES } from '../config.js';

// Each attachment is this many bytes; 3 of them fit under the cap, a 4th would not.
const CHUNK_BYTES = Math.floor(MEDIA_MAX_AGGREGATE_BYTES / 3);

const GROUP_FOLDER = 'test-group';

function makeTimestamp(index: number): string {
  // ISO strings sortable as strings; index 0 = oldest, 9 = newest.
  return new Date(1_700_000_000_000 + index * 60_000).toISOString();
}

describe('parseMediaReferences — aggregate-byte cap', () => {
  let tmpDir: string;
  let attachmentsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-media-test-'));
    attachmentsDir = path.join(tmpDir, 'groups', GROUP_FOLDER, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts at most 3 refs when each is MEDIA_MAX_AGGREGATE_BYTES/3 bytes', () => {
    const ROW_COUNT = 10;

    // Create 10 fake attachment files on disk.
    for (let i = 0; i < ROW_COUNT; i++) {
      const filename = `attachment-${i}.bin`;
      fs.writeFileSync(
        path.join(attachmentsDir, filename),
        Buffer.alloc(CHUNK_BYTES, 0),
      );
    }

    // Build DB rows: each row has one attachment; newest row has the highest index.
    const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: `msg-${i}`,
      chat_jid: 'test@g.us',
      timestamp: makeTimestamp(i),
      attachments: [
        {
          kind: 'document' as const,
          handlerName: 'test-handler',
          workspacePath: `attachments/attachment-${i}.bin`,
          mimetype: 'application/octet-stream',
          sizeBytes: CHUNK_BYTES,
        },
      ],
    }));

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    // No more than 3 refs should fit under the cap.
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it('returns refs sorted ascending by timestamp (oldest first)', () => {
    const ROW_COUNT = 6;

    for (let i = 0; i < ROW_COUNT; i++) {
      fs.writeFileSync(
        path.join(attachmentsDir, `sorted-${i}.bin`),
        Buffer.alloc(CHUNK_BYTES, 0),
      );
    }

    // Shuffle the input order to verify the function re-sorts correctly.
    const rows = [5, 2, 4, 0, 3, 1].map((i) => ({
      id: `msg-sorted-${i}`,
      chat_jid: 'test@g.us',
      timestamp: makeTimestamp(i),
      attachments: [
        {
          kind: 'document' as const,
          handlerName: 'test-handler',
          workspacePath: `attachments/sorted-${i}.bin`,
          mimetype: 'application/octet-stream',
          sizeBytes: CHUNK_BYTES,
        },
      ],
    }));

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    // Result must be sorted ascending (oldest first).
    for (let i = 1; i < result.length; i++) {
      // relativePaths encode the file index; compare directly on the returned paths.
      const prevIndex = parseInt(
        result[i - 1].relativePath
          .replace('attachments/sorted-', '')
          .replace('.bin', ''),
        10,
      );
      const currIndex = parseInt(
        result[i].relativePath
          .replace('attachments/sorted-', '')
          .replace('.bin', ''),
        10,
      );
      expect(prevIndex).toBeLessThan(currIndex);
    }
  });

  it('rejects path-traversal attempts (.. segments)', () => {
    // The traversal path should NOT appear in results regardless of disk state.
    const rows = [
      {
        id: 'msg-traversal',
        chat_jid: 'test@g.us',
        timestamp: makeTimestamp(0),
        attachments: [
          {
            kind: 'document' as const,
            handlerName: 'test-handler',
            workspacePath: 'attachments/../../../etc/passwd',
            mimetype: 'text/plain',
            sizeBytes: 100,
          },
        ],
      },
    ];

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    expect(result).toHaveLength(0);
  });

  it('rejects paths not starting with attachments/', () => {
    const rows = [
      {
        id: 'msg-bad-prefix',
        chat_jid: 'test@g.us',
        timestamp: makeTimestamp(0),
        attachments: [
          {
            kind: 'document' as const,
            handlerName: 'test-handler',
            workspacePath: 'secrets/token.txt',
            mimetype: 'text/plain',
            sizeBytes: 100,
          },
        ],
      },
    ];

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    expect(result).toHaveLength(0);
  });

  it('skips rows with null attachments without crashing', () => {
    const rows = [
      {
        id: 'msg-null',
        chat_jid: 'test@g.us',
        timestamp: makeTimestamp(0),
        attachments: null,
      },
    ];

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    expect(result).toHaveLength(0);
  });

  it('skips entries with an error field set', () => {
    const rows = [
      {
        id: 'msg-err',
        chat_jid: 'test@g.us',
        timestamp: makeTimestamp(0),
        attachments: [
          {
            kind: 'document' as const,
            handlerName: 'test-handler',
            workspacePath: 'attachments/will-not-be-read.bin',
            mimetype: 'application/octet-stream',
            sizeBytes: 100,
            error: 'download failed',
          },
        ],
      },
    ];

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    expect(result).toHaveLength(0);
  });

  it('skips attachments that do not exist on disk', () => {
    const rows = [
      {
        id: 'msg-missing',
        chat_jid: 'test@g.us',
        timestamp: makeTimestamp(0),
        attachments: [
          {
            kind: 'document' as const,
            handlerName: 'test-handler',
            workspacePath: 'attachments/nonexistent.bin',
            mimetype: 'application/octet-stream',
            sizeBytes: 100,
          },
        ],
      },
    ];

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    expect(result).toHaveLength(0);
  });

  it('newest-first walk means the 3 newest refs are kept under the cap', () => {
    const ROW_COUNT = 10;

    for (let i = 0; i < ROW_COUNT; i++) {
      fs.writeFileSync(
        path.join(attachmentsDir, `order-${i}.bin`),
        Buffer.alloc(CHUNK_BYTES, 0),
      );
    }

    const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: `msg-order-${i}`,
      chat_jid: 'test@g.us',
      timestamp: makeTimestamp(i),
      attachments: [
        {
          kind: 'document' as const,
          handlerName: 'test-handler',
          workspacePath: `attachments/order-${i}.bin`,
          mimetype: 'application/octet-stream',
          sizeBytes: CHUNK_BYTES,
        },
      ],
    }));

    const result = parseMediaReferences(rows, GROUP_FOLDER, tmpDir);

    // The walk is newest-first so the 3 highest-indexed (newest) rows are kept.
    const keptIndexes = result.map((r) =>
      parseInt(
        r.relativePath.replace('attachments/order-', '').replace('.bin', ''),
        10,
      ),
    );

    // All kept indexes must be among the newest ones (indices 7, 8, 9 for ROW_COUNT=10, 3 kept).
    const minExpectedIndex = ROW_COUNT - result.length;
    for (const idx of keptIndexes) {
      expect(idx).toBeGreaterThanOrEqual(minExpectedIndex);
    }

    // Returned order must be ascending (oldest to newest among the kept set).
    for (let i = 1; i < keptIndexes.length; i++) {
      expect(keptIndexes[i - 1]).toBeLessThan(keptIndexes[i]);
    }
  });
});
