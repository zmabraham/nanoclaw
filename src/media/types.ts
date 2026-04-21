export type MediaKind = 'voice' | 'image' | 'document' | 'video' | 'audio';

export interface MediaAttachmentRef {
  relativePath: string;
  mediaType: string;
}

export interface MediaRef {
  kind: MediaKind;
  mimetype: string;
  filename?: string;
  sizeBytes: number;
  caption?: string;
  buffer: Buffer;
}

export interface ProcessedAttachmentSummary {
  kind: MediaKind;
  handlerName: string;
  workspacePath?: string;
  mimetype: string;
  /** Bytes of the written file (handler output). May differ from the original
   * channel-declared sizeBytes for handlers that transcode or compress media. */
  sizeBytes?: number;
  error?: string;
}

export interface ProcessedMedia {
  textRepresentation: string;
  workspaceFile?: {
    relativePath: string;
    bytes: Buffer;
    /**
     * Mimetype of the bytes on disk — MUST be set when the handler transcodes
     * (e.g., image handler writes JPEG regardless of input). When omitted, the
     * pipeline falls back to the input `ref.mimetype`. Agent-runner whitelists
     * media types by this value, so transcoded formats that don't match the
     * input type (PNG → JPEG) need this explicitly set.
     */
    outputMimetype?: string;
  };
  handlerName: string;
  durationMs: number;
  error?: string;
}

export interface ProcessedMediaBundle {
  entries: ProcessedMedia[];
  aggregatedContent: string;
  attachmentSummaries: ProcessedAttachmentSummary[];
  totalDurationMs: number;
  error?: string;
}

export interface HandlerContext {
  groupFolder: string;
  chatJid: string;
  messageId: string;
}

export interface MediaHandler {
  name: string;
  matches(ref: MediaRef): boolean;
  priority?: number;
  process(
    ref: MediaRef,
    ctx: HandlerContext,
    signal: AbortSignal,
  ): Promise<ProcessedMedia>;
}
