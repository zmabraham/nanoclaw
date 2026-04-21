import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { MEDIA_MAX_AGGREGATE_BYTES } from '../config.js';
import type { MediaAttachmentRef, ProcessedAttachmentSummary } from './types.js';

interface MessageRowWithAttachments {
  id: string;
  chat_jid: string;
  timestamp: string;
  attachments: ProcessedAttachmentSummary[] | null;
}

/**
 * Parse attachment refs from a batch of DB rows. Reads the authoritative
 * `attachments` JSON column; NEVER scans `content`. Applies a 3-way
 * containment check, on-disk existence check, and the aggregate-byte cap
 * before yielding refs.
 *
 * The aggregate cap walks rows in REVERSE timestamp order (newest first) so
 * the most-recent refs win when the cap is reached; the returned array is
 * re-sorted ascending for stable prompt assembly.
 *
 * @param rows DB rows with their `attachments` JSON already parsed
 * @param groupFolder e.g. "main"
 * @param projectRoot absolute path to the project root; tests inject a tmpdir,
 *                    production callers pass `process.cwd()`.
 */
export function parseMediaReferences(
  rows: MessageRowWithAttachments[],
  groupFolder: string,
  projectRoot: string = process.cwd(),
): MediaAttachmentRef[] {
  const base = path.resolve(projectRoot, 'groups', groupFolder, 'attachments');
  // Reverse-timestamp walk: newest first, so the cap keeps the most-recent
  // refs if the total would exceed MEDIA_MAX_AGGREGATE_BYTES.
  const descending = [...rows].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const kept: Array<{ ref: MediaAttachmentRef; timestamp: string }> = [];
  let cumulativeBytes = 0;
  let skippedForCap = 0;

  // Label the outer loop so the first cap-exceeding entry stops the
  // entire reverse-time walk.
  capWalk: for (const row of descending) {
    if (!row.attachments) continue;
    for (const entry of row.attachments) {
      if (entry.error != null) continue;
      if (!entry.workspacePath) continue;
      const wp = entry.workspacePath;
      if (!wp.startsWith('attachments/')) {
        logger.warn({ row: row.id, workspacePath: wp }, 'parseMediaReferences: reject — not under attachments/');
        continue;
      }
      if (wp.split('/').includes('..')) {
        logger.warn({ row: row.id, workspacePath: wp }, 'parseMediaReferences: reject — ".." segment');
        continue;
      }
      const rel = path.relative('attachments', wp);
      const resolved = path.resolve(base, rel);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        logger.warn({ row: row.id, workspacePath: wp, resolved }, 'parseMediaReferences: reject — escapes base');
        continue;
      }
      if (!fs.existsSync(resolved)) {
        logger.warn({ row: row.id, workspacePath: wp }, 'parseMediaReferences: attachment missing on disk, skipping');
        continue;
      }
      // Aggregate-byte cap. sizeBytes is advisory; fall back to statSync if missing.
      let bytes = typeof entry.sizeBytes === 'number' && entry.sizeBytes > 0
        ? entry.sizeBytes
        : 0;
      if (!bytes) {
        try { bytes = fs.statSync(resolved).size; } catch { bytes = 0; }
      }
      if (cumulativeBytes + bytes > MEDIA_MAX_AGGREGATE_BYTES) {
        // Pessimistic upper bound: unvalidated entry count from this row onward.
        // Some of these would have been skipped anyway (missing file, error, containment).
        const fromIdx = descending.indexOf(row);
        skippedForCap = descending
          .slice(fromIdx)
          .reduce((acc, r) => acc + (r.attachments?.length ?? 0), 0);
        break capWalk;
      }
      cumulativeBytes += bytes;
      kept.push({ ref: { relativePath: wp, mediaType: entry.mimetype }, timestamp: row.timestamp });
    }
  }

  if (skippedForCap > 0) {
    logger.info({ skipped: skippedForCap, cap: MEDIA_MAX_AGGREGATE_BYTES }, 'mediaAttachments aggregate cap reached; N older refs skipped');
  }

  // Re-sort ascending (oldest → newest) for stable prompt assembly order.
  kept.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return kept.map((k) => k.ref);
}
