import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Generate an inbox filename with deterministic ordering. */
export function inboxFilename(): string {
  return `${Date.now()}-${crypto.randomUUID()}.json`;
}

/**
 * Verify a target path resolves within an allowed base directory.
 * Prevents symlink-based path traversal where a container replaces
 * an IPC subdirectory with a symlink to an arbitrary host path.
 * Throws if the resolved path escapes the base.
 */
export function assertWithinBase(targetPath: string, baseDir: string): void {
  const resolvedTarget = fs.realpathSync(targetPath);
  const resolvedBase = fs.realpathSync(baseDir);
  if (
    !resolvedTarget.startsWith(resolvedBase + path.sep) &&
    resolvedTarget !== resolvedBase
  ) {
    throw new Error(
      `Path traversal blocked: ${targetPath} resolves to ${resolvedTarget}, outside ${resolvedBase}`,
    );
  }
}

/** Atomically write a JSON file (write to temp, rename). */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Atomically write a JSON file with symlink-escape validation.
 * The directory must resolve within `baseDir` after symlink resolution.
 */
export function safeAtomicWriteJson(
  filePath: string,
  data: unknown,
  baseDir: string,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  assertWithinBase(dir, baseDir);
  atomicWriteJson(filePath, data);
}
