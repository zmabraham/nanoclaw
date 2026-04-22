import fs from 'fs';
import path from 'path';
import { MEDIA_MAX_BYTES, MEDIA_PIPELINE_MAX_CONCURRENCY } from '../config.js';
import { logger } from '../logger.js';
import { getMediaHandlers } from './registry.js';
import { fallbackHandler } from './handlers/fallback.js';
import type {
  HandlerContext,
  MediaHandler,
  MediaRef,
  ProcessedMedia,
  ProcessedMediaBundle,
  ProcessedAttachmentSummary,
} from './types.js';

interface PipelineOptions {
  projectRoot?: string;
  maxBytes?: number;
  handlerTimeoutMs?: number;
  maxConcurrency?: number;
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release(): void {
    if (this.active <= 0) {
      throw new Error(
        'Semaphore double-release — active counter would go negative',
      );
    }
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

function kindLabel(kind: MediaRef['kind']): string {
  switch (kind) {
    case 'voice':
      return 'Voice Message';
    case 'image':
      return 'Image';
    case 'document':
      return 'PDF';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    default:
      return 'media';
  }
}

// Exported so `src/channels/whatsapp.ts` can reuse the same fallback strings
// when it rejects oversized media pre-download.
export function fallbackMarker(kind: MediaRef['kind']): string {
  // Voice keeps its historical phrasing; all other kinds use the same "too large" suffix.
  if (kind === 'voice') return '[Voice Message - too large to transcribe]';
  return `[${kindLabel(kind)} - too large]`;
}

// Distinct from fallbackMarker: used when fileLength is missing/zero on the
// incoming proto. Cause is missing channel metadata, not size cap.
export function missingMetadataMarker(kind: MediaRef['kind']): string {
  return `[${kindLabel(kind)} - missing metadata, skipped]`;
}

// Distinct from fallbackMarker: used when the channel download throws or
// returns an empty buffer. Cause is a transient channel failure, not size cap.
export function downloadFailedMarker(kind: MediaRef['kind']): string {
  return `[${kindLabel(kind)} - download failed]`;
}

export class MediaPipeline {
  private readonly projectRoot: string;
  private readonly maxBytes: number;
  private readonly handlerTimeoutMs: number;
  private readonly sem: Semaphore;

  constructor(opts: PipelineOptions = {}) {
    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.maxBytes = opts.maxBytes ?? MEDIA_MAX_BYTES;
    this.handlerTimeoutMs = opts.handlerTimeoutMs ?? 60_000;
    this.sem = new Semaphore(
      opts.maxConcurrency ?? MEDIA_PIPELINE_MAX_CONCURRENCY,
    );
  }

  async process(
    refs: MediaRef[],
    groupFolder: string,
    chatJid: string,
    messageId: string,
  ): Promise<ProcessedMediaBundle> {
    await this.sem.acquire();
    try {
      return await this.runPipeline(refs, groupFolder, chatJid, messageId);
    } finally {
      this.sem.release();
    }
  }

  private async runPipeline(
    refs: MediaRef[],
    groupFolder: string,
    chatJid: string,
    messageId: string,
  ): Promise<ProcessedMediaBundle> {
    const start = Date.now();
    const ctx: HandlerContext = { groupFolder, chatJid, messageId };

    const entryPromises = refs.map(async (ref): Promise<ProcessedMedia> => {
      // Size cap — reject before dispatch
      if (ref.sizeBytes > this.maxBytes) {
        return {
          textRepresentation: fallbackMarker(ref.kind),
          handlerName: 'size-cap',
          durationMs: 0,
          error: `Media exceeds size limit (${Math.round(this.maxBytes / 1024 / 1024)} MB)`,
        };
      }

      // Pick highest-priority matching handler from registry.
      // Wrapped in try/catch: a buggy handler's matches() throw must not abort the
      // entire bundle — other refs in the same message should still be processed.
      let handler: MediaHandler;
      try {
        const candidates = getMediaHandlers().filter((h) => h.matches(ref));

        // If no specialized handler registered, fall back to the hardcoded fallback handler.
        // The fallback covers voice/video/audio; image and document without specialized
        // handlers will get an "unhandled" error (expected — those skills must be installed).
        if (candidates.length === 0) {
          if (fallbackHandler.matches(ref)) {
            handler = fallbackHandler;
          } else {
            return {
              textRepresentation: `[${ref.kind}]`,
              handlerName: 'unhandled',
              durationMs: 0,
              error: `No handler registered for kind "${ref.kind}" — install the relevant skill`,
            };
          }
        } else {
          candidates.sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100));
          handler = candidates[0];
        }
      } catch (matchErr) {
        return {
          textRepresentation: `[${ref.kind} - processing failed]`,
          handlerName: 'matches-error',
          durationMs: 0,
          error: `handler matches() threw: ${matchErr instanceof Error ? matchErr.message : String(matchErr)}`,
        };
      }

      const controller = new AbortController();
      const t0 = Date.now();
      const originalPromise = handler.process(ref, ctx, controller.signal);

      // Hazard #12: swallow late rejections from the abandoned promise when timeout wins
      originalPromise.catch(() => {});

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<ProcessedMedia>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            textRepresentation: `[${ref.kind} - processing failed]`,
            handlerName: handler.name,
            durationMs: Date.now() - t0,
            error: 'handler timeout',
          });
        }, this.handlerTimeoutMs);
      });

      try {
        return await Promise.race([originalPromise, timeoutPromise]);
      } catch (err) {
        return {
          textRepresentation: `[${ref.kind} - processing failed]`,
          handlerName: handler.name,
          durationMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });

    const entries = await Promise.all(entryPromises);

    // Single-writer filesystem: pipeline persists workspaceFile bytes
    const attachDir = path.join(
      this.projectRoot,
      'groups',
      groupFolder,
      'attachments',
    );
    fs.mkdirSync(attachDir, { recursive: true });
    const summaries: ProcessedAttachmentSummary[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const ref = refs[i];
      if (entry.workspaceFile) {
        // Normalize the handler-returned path so workspacePath in summaries uses the
        // same form as the actual write path (path.join normalizes internally; storing
        // the raw relativePath could leave '..' or '.' segments in the DB record).
        const relPath = path.normalize(entry.workspaceFile.relativePath);
        const abs = path.join(this.projectRoot, 'groups', groupFolder, relPath);
        let writeFailed = false;
        // Containment check: handler-returned relativePath must resolve inside attachments/.
        // A buggy or compromised handler returning '../../../etc/passwd' would otherwise
        // overwrite arbitrary host files. This is defense-in-depth on top of the
        // single-writer invariant documented in the spec.
        if (!abs.startsWith(attachDir + path.sep)) {
          logger.warn(
            { handlerName: entry.handlerName, path: abs },
            'pipeline: workspaceFile path escapes attachments dir — skipping write',
          );
          writeFailed = true;
          entry.textRepresentation = `[${ref.kind} - error]`;
          entry.error =
            (entry.error ? entry.error + '; ' : '') + `workspace-path-escape`;
        }
        if (!writeFailed) {
          try {
            // Use exclusive create (flag 'wx') so a duplicate relativePath from a
            // concurrent handler does not silently overwrite the earlier file.
            await fs.promises.writeFile(abs, entry.workspaceFile.bytes, {
              flag: 'wx',
            });
          } catch (err) {
            writeFailed = true;
            const writeErr = err instanceof Error ? err.message : String(err);
            logger.warn(
              { err, path: abs },
              'pipeline: workspaceFile write failed',
            );
            entry.textRepresentation = `[${ref.kind} - write failed]`;
            entry.error =
              (entry.error ? entry.error + '; ' : '') +
              `workspace-write-failed: ${writeErr}`;
          }
        }
        summaries.push({
          kind: ref.kind,
          handlerName: entry.handlerName,
          ...(writeFailed ? {} : { workspacePath: relPath }),
          // Use the handler's output mimetype when the file was actually written
          // (image handler transcodes to JPEG). On writeFailed, fall back to the
          // input mimetype since no transcoded bytes exist on disk. Agent-runner
          // whitelists by this value — recording input mimetype for a written
          // transcoded file (e.g. "image/png" for a JPEG) drops the block.
          mimetype: writeFailed
            ? ref.mimetype
            : (entry.workspaceFile.outputMimetype ?? ref.mimetype),
          sizeBytes: entry.workspaceFile.bytes.length,
          error: entry.error,
        });
      } else if (entry.error == null && ref.sizeBytes <= this.maxBytes) {
        // Non-file-producing handler (voice-transcription) — still summarize
        summaries.push({
          kind: ref.kind,
          handlerName: entry.handlerName,
          mimetype: ref.mimetype,
        });
      }
      // Size-cap rejections are NOT summarized
    }

    const joined = entries
      .map((e) => e.textRepresentation.trim())
      .filter(Boolean)
      .join(' ');
    const aggregatedContent = joined || '[Media]';

    return {
      entries,
      aggregatedContent,
      attachmentSummaries: summaries,
      totalDurationMs: Date.now() - start,
    };
  }
}
