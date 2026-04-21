import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerMediaHandler,
  getMediaHandlers,
  _resetForTests,
  FALLBACK_PRIORITY,
  MIN_SPECIALIZED_PRIORITY,
} from './registry.js';
import type { MediaHandler, MediaRef, ProcessedMedia, HandlerContext } from './types.js';

function fakeHandler(name: string, kind: 'voice' | 'image' | 'video' | 'audio' | 'document', priority?: number): MediaHandler {
  return {
    name,
    priority,
    matches: (ref: MediaRef) => ref.kind === kind,
    async process(_r: MediaRef, _c: HandlerContext, _s: AbortSignal): Promise<ProcessedMedia> {
      return { textRepresentation: name, handlerName: name, durationMs: 0 };
    },
  };
}

describe('media registry', () => {
  beforeEach(() => _resetForTests());

  it('registers and retrieves handlers', () => {
    registerMediaHandler(fakeHandler('vt', 'voice', 100));
    const handlers = getMediaHandlers();
    expect(handlers.map((h) => h.name)).toEqual(['vt']);
  });

  it('throws on (kind, priority) collision between two specialized handlers', () => {
    registerMediaHandler(fakeHandler('vt', 'voice', 100));
    expect(() => registerMediaHandler(fakeHandler('vt2', 'voice', 100))).toThrow(
      /vt.*vt2|vt2.*vt/,
    );
  });

  it('allows same priority across different kinds', () => {
    registerMediaHandler(fakeHandler('vt', 'voice', 100));
    expect(() => registerMediaHandler(fakeHandler('img', 'image', 100))).not.toThrow();
  });

  it('rejects specialized handler at FALLBACK_PRIORITY (0)', () => {
    expect(() => registerMediaHandler(fakeHandler('x', 'image', FALLBACK_PRIORITY))).toThrow(
      /priority must be >= 1/i,
    );
  });

  it('allows fallback-module handler explicitly declared at priority 0', () => {
    expect(MIN_SPECIALIZED_PRIORITY).toBe(1);
    expect(FALLBACK_PRIORITY).toBe(0);
  });

  it('rejects non-integer priority', () => {
    expect(() => registerMediaHandler(fakeHandler('x', 'image', 1.5))).toThrow(
      /non-negative safe integer/i,
    );
  });

  it('rejects negative priority', () => {
    expect(() => registerMediaHandler(fakeHandler('x', 'image', -1))).toThrow(
      /non-negative safe integer/i,
    );
  });

  it('rejects NaN priority', () => {
    expect(() => registerMediaHandler(fakeHandler('x', 'image', NaN))).toThrow(
      /non-negative safe integer/i,
    );
  });

  it('defaults priority to 100 for specialized handlers', () => {
    registerMediaHandler(fakeHandler('x', 'image')); // no priority arg
    const h = getMediaHandlers()[0];
    expect(h.priority ?? 100).toBe(100);
  });
});
