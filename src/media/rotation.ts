import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import {
  MEDIA_MAX_FILES,
  MEDIA_RETAIN_FILES,
} from '../config.js';

export interface RotateOpts {
  projectRoot?: string;
  groupFolder: string;
  retainTarget?: number;
  hysteresisTop?: number;
  maxFiles?: number;
  /** @deprecated Accepted for test compatibility; rotation trusts referencedPaths directly. */
  referenceFloorMs?: number;
  referencedPaths?: Set<string>;
}

export function rotateAttachments(opts: RotateOpts): void {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const retainTarget = opts.retainTarget ?? MEDIA_RETAIN_FILES;
  const hysteresisTop = opts.hysteresisTop ?? retainTarget * 1.2;
  const maxFiles = opts.maxFiles ?? MEDIA_MAX_FILES;
  const refs = opts.referencedPaths ?? new Set<string>();

  const dir = path.join(projectRoot, 'groups', opts.groupFolder, 'attachments');
  if (!fs.existsSync(dir)) return;

  const items = fs
    .readdirSync(dir)
    .map((name) => {
      const p = path.join(dir, name);
      const stat = fs.statSync(p);
      return { name, path: p, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
    })
    .filter((item) => item.isFile)
    .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  const count = items.length;
  if (count < hysteresisTop && count <= maxFiles) return;

  const target = count > maxFiles ? maxFiles : retainTarget;

  let remaining = count;
  for (const item of items) {
    if (remaining <= target) break;
    const rel = `attachments/${item.name}`;
    const hardCeilingHit = remaining > maxFiles;
    const isProtected = refs.has(rel);
    if (isProtected && !hardCeilingHit) continue;
    try {
      fs.unlinkSync(item.path);
      remaining--;
    } catch (err) {
      logger.warn({ err, path: item.path }, 'rotateAttachments: unlink failed');
    }
  }
}
