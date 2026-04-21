import { MediaHandler } from './types.js';

export const FALLBACK_PRIORITY = 0;
export const MIN_SPECIALIZED_PRIORITY = 1;

const handlers: MediaHandler[] = [];
const slots = new Map<string, string>(); // `${kind}:${priority}` -> handlerName

function slotKey(kind: string, priority: number): string {
  return `${kind}:${priority}`;
}

export function registerMediaHandler(h: MediaHandler): void {
  const priority = h.priority ?? 100;
  if (!Number.isSafeInteger(priority) || priority < 0) {
    throw new Error(
      `Handler priority must be a non-negative safe integer (got ${String(priority)})`,
    );
  }
  // All handlers registered via this function must use a specialized priority
  // (>= MIN_SPECIALIZED_PRIORITY). FALLBACK_PRIORITY (0) is reserved for the
  // fallback module and cannot be registered here.
  if (priority < MIN_SPECIALIZED_PRIORITY) {
    throw new Error(
      'Specialized handler priority must be >= 1 (0 is reserved for fallback).',
    );
  }
  // We know `matches` is defined on MediaHandler; for collision detection we need
  // to know which kind(s) the handler covers. Per spec, each handler covers exactly
  // one kind (voice, image, document, video, audio); the module reading the handler
  // knows which kind. We encode that here via a probe against representative refs
  // — tests pass fake handlers keyed to specific kinds.
  const kinds: Array<'voice' | 'image' | 'document' | 'video' | 'audio'> = [
    'voice',
    'image',
    'document',
    'video',
    'audio',
  ];
  // Use canonical MIME per kind so handlers that narrow on both kind AND mimetype
  // (e.g. PDF handler: kind==='document' && mimetype==='application/pdf') are
  // correctly detected. A probe with 'application/octet-stream' would cause those
  // handlers to return false for every probe and throw at registration.
  const canonicalMimeByKind: Record<(typeof kinds)[number], string> = {
    voice: 'audio/ogg',
    image: 'image/jpeg',
    document: 'application/pdf',
    video: 'video/mp4',
    audio: 'audio/mpeg',
  };
  const probeBase = {
    sizeBytes: 0,
    buffer: Buffer.alloc(0),
  } as const;
  const matchedKinds = kinds.filter((k) =>
    h.matches({ ...probeBase, kind: k, mimetype: canonicalMimeByKind[k] }),
  );
  if (matchedKinds.length === 0) {
    throw new Error(
      `Handler ${h.name} matches() returned false for all MediaKind probes — cannot register`,
    );
  }
  for (const kind of matchedKinds) {
    const key = slotKey(kind, priority);
    const existing = slots.get(key);
    if (existing) {
      throw new Error(
        `Media handler priority collision at (${kind}, ${priority}): ${existing} vs ${h.name}`,
      );
    }
  }
  for (const kind of matchedKinds) {
    slots.set(slotKey(kind, priority), h.name);
  }
  handlers.push(h);
}

export function getMediaHandlers(): MediaHandler[] {
  return [...handlers];
}

/** @internal — test-only */
export function _resetForTests(): void {
  handlers.length = 0;
  slots.clear();
}
