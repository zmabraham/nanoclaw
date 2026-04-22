import { describe, it, expect } from 'vitest';
import { fallbackHandler } from './fallback.js';
import type { MediaRef, HandlerContext } from '../types.js';

describe('fallback handler', () => {
  const ctx: HandlerContext = {
    groupFolder: 'main',
    chatJid: 'c',
    messageId: 'm',
  };
  const signal = new AbortController().signal;

  it('matches video, audio, and voice kinds', () => {
    expect(
      fallbackHandler.matches({
        kind: 'video',
        mimetype: 'video/mp4',
        sizeBytes: 1,
        buffer: Buffer.alloc(1),
      }),
    ).toBe(true);
    expect(
      fallbackHandler.matches({
        kind: 'audio',
        mimetype: 'audio/mpeg',
        sizeBytes: 1,
        buffer: Buffer.alloc(1),
      }),
    ).toBe(true);
    expect(
      fallbackHandler.matches({
        kind: 'voice',
        mimetype: 'audio/ogg',
        sizeBytes: 1,
        buffer: Buffer.alloc(1),
      }),
    ).toBe(true);
    expect(
      fallbackHandler.matches({
        kind: 'image',
        mimetype: 'image/jpeg',
        sizeBytes: 1,
        buffer: Buffer.alloc(1),
      }),
    ).toBe(false);
  });

  it('emits [Video: attachments/...] marker with resolved extension', async () => {
    const res = await fallbackHandler.process(
      {
        kind: 'video',
        mimetype: 'video/mp4',
        sizeBytes: 10,
        buffer: Buffer.from('mp4bytes'),
      },
      ctx,
      signal,
    );
    expect(res.textRepresentation).toMatch(
      /^\[Video: attachments\/vid-\d+-[a-z0-9]{4}\.mp4\]$/,
    );
    expect(res.workspaceFile?.relativePath).toMatch(/^attachments\/vid-/);
  });

  it('appends caption when present', async () => {
    const res = await fallbackHandler.process(
      {
        kind: 'video',
        mimetype: 'video/mp4',
        sizeBytes: 10,
        buffer: Buffer.from('x'),
        caption: 'sunset',
      },
      ctx,
      signal,
    );
    expect(res.textRepresentation).toMatch(/sunset$/);
  });

  it('falls back to .bin on unknown mimetype', async () => {
    const res = await fallbackHandler.process(
      {
        kind: 'audio',
        mimetype: 'application/x-custom',
        sizeBytes: 1,
        buffer: Buffer.from('x'),
      },
      ctx,
      signal,
    );
    expect(res.textRepresentation).toMatch(/\.bin\]/);
  });
});
