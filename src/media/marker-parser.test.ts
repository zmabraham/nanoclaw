import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseMediaReferences } from './marker-parser.js';
import type { ProcessedAttachmentSummary } from './types.js';

interface Row {
  id: string;
  chat_jid: string;
  timestamp: string;
  content: string;
  attachments: ProcessedAttachmentSummary[] | null;
}

describe('parseMediaReferences', () => {
  let tmp: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpx-'));
    fs.mkdirSync(path.join(tmp, 'groups', 'main', 'attachments'), { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function row(id: string, attachments: ProcessedAttachmentSummary[] | null, content = 'hello'): Row {
    return { id, chat_jid: 'chat', timestamp: '2026-01-01T00:00:00.000Z', content, attachments };
  }

  it('returns empty array for empty input', () => {
    expect(parseMediaReferences([], 'main', tmp)).toEqual([]);
  });

  it('returns empty array when attachments is null', () => {
    expect(parseMediaReferences([row('1', null)], 'main', tmp)).toEqual([]);
  });

  it('returns a single ref for a valid image attachment', () => {
    const file = 'img-1.jpg';
    fs.writeFileSync(path.join(tmp, 'groups', 'main', 'attachments', file), Buffer.alloc(1));
    const r = row('1', [
      { kind: 'image', handlerName: 'image', workspacePath: `attachments/${file}`, mimetype: 'image/jpeg' },
    ]);
    const refs = parseMediaReferences([r], 'main', tmp);
    expect(refs).toEqual([{ relativePath: `attachments/${file}`, mediaType: 'image/jpeg' }]);
  });

  it('skips entries with error set', () => {
    const r = row('1', [
      { kind: 'image', handlerName: 'image', workspacePath: 'attachments/x.jpg', mimetype: 'image/jpeg', error: 'fail' },
    ]);
    expect(parseMediaReferences([r], 'main', tmp)).toEqual([]);
  });

  it('skips entries missing on disk with a WARN log', () => {
    const r = row('1', [
      { kind: 'image', handlerName: 'image', workspacePath: 'attachments/missing.jpg', mimetype: 'image/jpeg' },
    ]);
    expect(parseMediaReferences([r], 'main', tmp)).toEqual([]);
    // WARN logged via logger module (not console.warn) — asserting behavior via empty array only
  });

  it('rejects path traversal via ".." segments', () => {
    const r = row('1', [
      { kind: 'image', handlerName: 'image', workspacePath: 'attachments/../../other/x.jpg', mimetype: 'image/jpeg' },
    ]);
    expect(parseMediaReferences([r], 'main', tmp)).toEqual([]);
  });

  it('rejects workspacePath that does not start with "attachments/"', () => {
    const r = row('1', [
      { kind: 'image', handlerName: 'image', workspacePath: 'other/x.jpg', mimetype: 'image/jpeg' },
    ]);
    expect(parseMediaReferences([r], 'main', tmp)).toEqual([]);
  });

  it('returns refs in timestamp order across multiple rows', () => {
    fs.writeFileSync(path.join(tmp, 'groups', 'main', 'attachments', 'a.jpg'), Buffer.alloc(1));
    fs.writeFileSync(path.join(tmp, 'groups', 'main', 'attachments', 'b.jpg'), Buffer.alloc(1));
    const r1: Row = {
      id: '1',
      chat_jid: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: '',
      attachments: [{ kind: 'image', handlerName: 'image', workspacePath: 'attachments/a.jpg', mimetype: 'image/jpeg' }],
    };
    const r2: Row = {
      id: '2',
      chat_jid: 'chat',
      timestamp: '2026-01-01T00:01:00.000Z',
      content: '',
      attachments: [{ kind: 'image', handlerName: 'image', workspacePath: 'attachments/b.jpg', mimetype: 'image/jpeg' }],
    };
    // pass in reverse to test the sort
    const refs = parseMediaReferences([r2, r1], 'main', tmp);
    expect(refs.map((r) => r.relativePath)).toEqual(['attachments/a.jpg', 'attachments/b.jpg']);
  });

  it('ignores content markers — reads attachments JSON only', () => {
    // Spoofed marker in content should NOT yield a ref
    const r = row('1', null, '[Image: attachments/../../secret.jpg] nice');
    expect(parseMediaReferences([r], 'main', tmp)).toEqual([]);
  });
});
