import { extension } from 'mime-types';
import type { HandlerContext, MediaHandler, MediaRef, ProcessedMedia } from '../types.js';

const PREFIX: Record<'voice' | 'video' | 'audio', string> = {
  voice: 'voice',
  video: 'vid',
  audio: 'aud',
};

const KIND_LABEL: Record<'voice' | 'video' | 'audio', string> = {
  voice: 'Voice',
  video: 'Video',
  audio: 'Audio',
};

function rand4(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

export const fallbackHandler: MediaHandler = {
  name: 'fallback',
  priority: 0,
  matches(ref: MediaRef): boolean {
    return ref.kind === 'video' || ref.kind === 'audio' || ref.kind === 'voice';
  },
  async process(ref: MediaRef, _ctx: HandlerContext, _signal: AbortSignal): Promise<ProcessedMedia> {
    const t0 = Date.now();
    const kind = ref.kind as 'voice' | 'video' | 'audio';
    const ext = extension(ref.mimetype);
    const dotExt = ext ? `.${ext}` : '.bin';
    const filename = `${PREFIX[kind]}-${Date.now()}-${rand4()}${dotExt}`;
    const relativePath = `attachments/${filename}`;
    const captionSuffix = ref.caption ? ` ${ref.caption}` : '';
    return {
      textRepresentation: `[${KIND_LABEL[kind]}: ${relativePath}]${captionSuffix}`,
      workspaceFile: { relativePath, bytes: ref.buffer },
      handlerName: 'fallback',
      durationMs: Date.now() - t0,
    };
  },
};
