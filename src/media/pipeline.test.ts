import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MediaPipeline } from './pipeline.js';
import { registerMediaHandler, _resetForTests } from './registry.js';
import type {
  MediaHandler,
  MediaRef,
  ProcessedMedia,
  HandlerContext,
} from './types.js';

function handler(
  name: string,
  kind: MediaRef['kind'],
  priority: number,
  fn: (
    ref: MediaRef,
    ctx: HandlerContext,
    signal: AbortSignal,
  ) => Promise<ProcessedMedia>,
): MediaHandler {
  return { name, priority, matches: (r) => r.kind === kind, process: fn };
}

describe('MediaPipeline', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
    fs.mkdirSync(path.join(tmp, 'groups', 'main', 'attachments'), {
      recursive: true,
    });
    _resetForTests();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const baseRef = (overrides: Partial<MediaRef> = {}): MediaRef => ({
    kind: 'image',
    mimetype: 'image/jpeg',
    sizeBytes: 1024,
    buffer: Buffer.alloc(1024),
    ...overrides,
  });

  const pipelineWithRoot = () => new MediaPipeline({ projectRoot: tmp });

  it('returns empty bundle for empty refs', async () => {
    const pipeline = pipelineWithRoot();
    const bundle = await pipeline.process([], 'main', 'c', 'm');
    expect(bundle.entries).toEqual([]);
    expect(bundle.aggregatedContent).toBe('[Media]');
  });

  it('highest priority handler wins', async () => {
    registerMediaHandler(
      handler('low', 'image', 100, async () => ({
        textRepresentation: 'low',
        handlerName: 'low',
        durationMs: 1,
      })),
    );
    registerMediaHandler(
      handler('high', 'image', 200, async () => ({
        textRepresentation: 'high',
        handlerName: 'high',
        durationMs: 1,
      })),
    );
    const bundle = await pipelineWithRoot().process(
      [baseRef()],
      'main',
      'c',
      'm',
    );
    expect(bundle.entries[0].handlerName).toBe('high');
  });

  it('size cap rejects before dispatch', async () => {
    registerMediaHandler(
      handler('x', 'image', 100, async () => ({
        textRepresentation: 'x',
        handlerName: 'x',
        durationMs: 1,
      })),
    );
    const huge = baseRef({ sizeBytes: 100 * 1024 * 1024 });
    const bundle = await new MediaPipeline({
      projectRoot: tmp,
      maxBytes: 25 * 1024 * 1024,
    }).process([huge], 'main', 'c', 'm');
    expect(bundle.entries[0].error).toMatch(/size limit/i);
    expect(bundle.entries[0].textRepresentation).toMatch(/too large/i);
  });

  it('per-handler 60s timeout fires with fallback; abandoned promise gets .catch', async () => {
    let unhandledSeen = false;
    const orig = process.listeners('unhandledRejection').slice();
    for (const l of orig) process.off('unhandledRejection', l as never);
    const probe = () => {
      unhandledSeen = true;
    };
    process.on('unhandledRejection', probe);
    try {
      registerMediaHandler(
        handler('slow', 'image', 100, async (_r, _c, signal) => {
          // Ignores signal; simulates a rogue handler that rejects LATE
          return new Promise((_, reject) =>
            setTimeout(() => reject(new Error('late')), 300),
          );
        }),
      );
      const bundle = await new MediaPipeline({
        projectRoot: tmp,
        handlerTimeoutMs: 50,
      }).process([baseRef()], 'main', 'c', 'm');
      expect(bundle.entries[0].error).toMatch(/timeout/i);
      // Wait past the rogue rejection point so .catch (if missing) would surface
      await new Promise((r) => setTimeout(r, 500));
      expect(unhandledSeen).toBe(false);
    } finally {
      process.off('unhandledRejection', probe);
      for (const l of orig) process.on('unhandledRejection', l as never);
    }
  });

  it('writes workspace files (single-writer invariant)', async () => {
    registerMediaHandler(
      handler('img', 'image', 100, async () => ({
        textRepresentation: '[Image: attachments/f.jpg]',
        handlerName: 'img',
        durationMs: 1,
        workspaceFile: {
          relativePath: 'attachments/f.jpg',
          bytes: Buffer.from('abc'),
        },
      })),
    );
    const bundle = await pipelineWithRoot().process(
      [baseRef()],
      'main',
      'c',
      'm',
    );
    const file = path.join(tmp, 'groups', 'main', 'attachments', 'f.jpg');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file).toString()).toBe('abc');
    expect(bundle.attachmentSummaries[0].workspacePath).toBe(
      'attachments/f.jpg',
    );
  });

  it('records output mimetype from handler when transcoding (e.g. PNG input → JPEG output)', async () => {
    // Simulates the image handler: accepts any image/*, writes JPEG regardless of input.
    // Without outputMimetype, the summary would record the input ("image/png") and the
    // agent-runner whitelist (image/jpeg only) would drop the block.
    registerMediaHandler(
      handler('img', 'image', 100, async () => ({
        textRepresentation: '[Image: attachments/f.jpg]',
        handlerName: 'img',
        durationMs: 1,
        workspaceFile: {
          relativePath: 'attachments/f.jpg',
          bytes: Buffer.from('jpeg-bytes'),
          outputMimetype: 'image/jpeg',
        },
      })),
    );
    const pngInput = baseRef({ mimetype: 'image/png' });
    const bundle = await pipelineWithRoot().process(
      [pngInput],
      'main',
      'c',
      'm',
    );
    expect(bundle.attachmentSummaries[0].mimetype).toBe('image/jpeg');
  });

  it('falls back to input mimetype when handler does not set outputMimetype', async () => {
    registerMediaHandler(
      handler('pdf', 'document', 100, async () => ({
        textRepresentation: '[PDF: attachments/d.pdf]',
        handlerName: 'pdf',
        durationMs: 1,
        workspaceFile: {
          relativePath: 'attachments/d.pdf',
          bytes: Buffer.from('pdf-bytes'),
        },
      })),
    );
    const pdfInput = baseRef({ kind: 'document', mimetype: 'application/pdf' });
    const bundle = await pipelineWithRoot().process(
      [pdfInput],
      'main',
      'c',
      'm',
    );
    expect(bundle.attachmentSummaries[0].mimetype).toBe('application/pdf');
  });

  it('aggregates text representations with single-space join, trims', async () => {
    registerMediaHandler(
      handler('img', 'image', 100, async () => ({
        textRepresentation: '[Image: x]',
        handlerName: 'img',
        durationMs: 1,
      })),
    );
    registerMediaHandler(
      handler('vid', 'video', 100, async () => ({
        textRepresentation: '[Video: y]',
        handlerName: 'vid',
        durationMs: 1,
      })),
    );
    const bundle = await pipelineWithRoot().process(
      [baseRef({ kind: 'image' }), baseRef({ kind: 'video' })],
      'main',
      'c',
      'm',
    );
    expect(bundle.aggregatedContent).toBe('[Image: x] [Video: y]');
  });

  it('concurrency cap gates parallel bundles', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    registerMediaHandler(
      handler('img', 'image', 100, async () => {
        inFlight++;
        if (inFlight > maxSeen) maxSeen = inFlight;
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { textRepresentation: 'x', handlerName: 'img', durationMs: 30 };
      }),
    );
    const pipeline = new MediaPipeline({ projectRoot: tmp, maxConcurrency: 2 });
    const ref = baseRef();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pipeline.process([ref], 'main', 'c', `m${i}`),
      ),
    );
    expect(maxSeen).toBeLessThanOrEqual(2);
  });
});
