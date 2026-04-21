import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { IpcHandler, registerIpcHandler } from '../ipc-handlers.js';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

/** 30s timeout for gh commands — prevents hung processes on network issues or auth prompts. */
const GH_TIMEOUT = 30_000;

function writeIpcResponse(
  sourceGroup: string,
  requestId: string,
  response: object,
): void {
  // Sanitize requestId to prevent path traversal
  const safeId = path.basename(requestId);
  if (!safeId || safeId !== requestId) {
    logger.warn({ sourceGroup, requestId }, 'Rejected IPC response write due to unsafe requestId');
    return;
  }

  const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responseFile = path.join(responsesDir, `${safeId}.json`);
  const tempFile = `${responseFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(response));
  fs.renameSync(tempFile, responseFile);
}

function respond(
  sourceGroup: string,
  requestId: string | undefined,
  response: object,
): void {
  if (requestId) writeIpcResponse(sourceGroup, requestId, response);
}

function errorResponse(
  sourceGroup: string,
  requestId: string | undefined,
  error: string,
): void {
  respond(sourceGroup, requestId, { status: 'error', error });
}

/** Validate gist ID format (lowercase hex string, 20-32 chars). */
function isValidGistId(id: string): boolean {
  return /^[a-f0-9]{20,32}$/.test(id);
}

/** Reject empty, '.', '..', and leading hyphens — prevents path traversal and argument injection. */
function isSafeName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.startsWith('-');
}

// --- Handlers ---

const gistCreate: IpcHandler = async (data, _deps, context) => {
  const requestId = data.requestId as string | undefined;
  const files = data.files as Record<string, string> | undefined;
  const description = data.description as string | undefined;
  const isPublic = data.public === true;

  if (!files || Object.keys(files).length === 0) {
    errorResponse(context.sourceGroup, requestId, 'Missing or empty "files" field');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gist-'));
  try {
    const filePaths: string[] = [];
    const seenNames = new Set<string>();
    for (const [name, content] of Object.entries(files)) {
      const safeName = path.basename(name);
      if (!isSafeName(safeName)) {
        errorResponse(context.sourceGroup, requestId, `Invalid filename: ${name}`);
        return;
      }
      if (seenNames.has(safeName)) {
        errorResponse(context.sourceGroup, requestId, `Duplicate filename after path resolution: ${safeName}`);
        return;
      }
      seenNames.add(safeName);
      const filePath = path.join(tmpDir, safeName);
      fs.writeFileSync(filePath, content);
      filePaths.push(filePath);
    }

    const args = ['gist', 'create', ...filePaths];
    if (description) args.push('--desc', description);
    if (isPublic) args.push('--public');

    const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT });
    const url = stdout.trim();

    logger.info({ sourceGroup: context.sourceGroup, url }, 'Gist created');
    respond(context.sourceGroup, requestId, { status: 'ok', url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup: context.sourceGroup }, 'gist_create failed');
    errorResponse(context.sourceGroup, requestId, msg);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

const gistView: IpcHandler = async (data, _deps, context) => {
  const requestId = data.requestId as string | undefined;
  const gistId = data.gistId as string | undefined;

  if (!gistId || !isValidGistId(gistId)) {
    errorResponse(context.sourceGroup, requestId, 'Missing or invalid "gistId"');
    return;
  }

  try {
    // gh gist view has no --json flag; use the REST API for structured output
    const { stdout } = await execFileAsync('gh', [
      'api', `/gists/${gistId}`,
    ], { timeout: GH_TIMEOUT });
    const gist = JSON.parse(stdout);
    const files: Record<string, { content: string; size: number; raw_url: string; truncated?: boolean }> = {};
    for (const [name, meta] of Object.entries(gist.files as Record<string, any>)) {
      const file: { content: string; size: number; raw_url: string; truncated?: boolean } = {
        content: meta.content, size: meta.size, raw_url: meta.raw_url,
      };
      if (meta.truncated) file.truncated = true;
      files[name] = file;
    }
    respond(context.sourceGroup, requestId, {
      status: 'ok',
      description: gist.description,
      url: gist.html_url,
      files,
      createdAt: gist.created_at,
      updatedAt: gist.updated_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup: context.sourceGroup }, 'gist_view failed');
    errorResponse(context.sourceGroup, requestId, msg);
  }
};

const gistEdit: IpcHandler = async (data, _deps, context) => {
  const requestId = data.requestId as string | undefined;
  const gistId = data.gistId as string | undefined;
  const files = data.files as Record<string, string> | undefined;
  const description = data.description as string | undefined;

  if (!gistId || !isValidGistId(gistId)) {
    errorResponse(context.sourceGroup, requestId, 'Missing or invalid "gistId"');
    return;
  }
  const fileEntries = files ? Object.entries(files) : [];
  if (fileEntries.length === 0 && !description) {
    errorResponse(context.sourceGroup, requestId, 'Nothing to edit: provide "files" or "description"');
    return;
  }

  // Validate filenames before making any API calls
  for (const [name] of fileEntries) {
    const safeName = path.basename(name);
    if (!isSafeName(safeName)) {
      errorResponse(context.sourceGroup, requestId, `Invalid filename: ${name}`);
      return;
    }
  }

  // Use the REST API — gh gist edit --add only adds new files and accepts
  // one file per invocation. PATCH /gists/{id} handles add + update natively.
  const payload: Record<string, any> = {};
  if (description !== undefined) payload.description = description;
  if (fileEntries.length > 0) {
    const apiFiles: Record<string, { content: string }> = {};
    for (const [name, content] of fileEntries) {
      apiFiles[path.basename(name)] = { content };
    }
    payload.files = apiFiles;
  }

  const tmpFile = path.join(os.tmpdir(), `gist-edit-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(payload));
    await execFileAsync('gh', [
      'api', '--method=PATCH', `/gists/${gistId}`, '--input', tmpFile,
    ], { timeout: GH_TIMEOUT });

    logger.info({ sourceGroup: context.sourceGroup, gistId }, 'Gist edited');
    respond(context.sourceGroup, requestId, { status: 'ok' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup: context.sourceGroup }, 'gist_edit failed');
    errorResponse(context.sourceGroup, requestId, msg);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
};

const gistDelete: IpcHandler = async (data, _deps, context) => {
  const requestId = data.requestId as string | undefined;
  const gistId = data.gistId as string | undefined;

  if (!context.isMain) {
    errorResponse(context.sourceGroup, requestId, 'gist_delete is restricted to the main group. Use intercom to ask main to delete it.');
    return;
  }

  if (!gistId || !isValidGistId(gistId)) {
    errorResponse(context.sourceGroup, requestId, 'Missing or invalid "gistId"');
    return;
  }

  try {
    await execFileAsync('gh', ['gist', 'delete', gistId, '--yes'], { timeout: GH_TIMEOUT });
    logger.info({ sourceGroup: context.sourceGroup, gistId }, 'Gist deleted');
    respond(context.sourceGroup, requestId, { status: 'ok' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup: context.sourceGroup }, 'gist_delete failed');
    errorResponse(context.sourceGroup, requestId, msg);
  }
};

const gistClone: IpcHandler = async (data, _deps, context) => {
  const requestId = data.requestId as string | undefined;
  const gistId = data.gistId as string | undefined;
  const targetDir = data.targetDir as string | undefined;

  if (!gistId || !isValidGistId(gistId)) {
    errorResponse(context.sourceGroup, requestId, 'Missing or invalid "gistId"');
    return;
  }

  try {
    const groupDir = resolveGroupFolderPath(context.sourceGroup);
    const cloneName = targetDir ? path.basename(targetDir) : gistId;
    if (!isSafeName(cloneName)) {
      errorResponse(context.sourceGroup, requestId, 'Invalid target directory name');
      return;
    }
    const args = ['gist', 'clone', gistId, cloneName];

    await execFileAsync('gh', args, { cwd: groupDir, timeout: GH_TIMEOUT });

    const containerPath = `/workspace/group/${cloneName}`;

    logger.info({ sourceGroup: context.sourceGroup, gistId, containerPath }, 'Gist cloned');
    respond(context.sourceGroup, requestId, { status: 'ok', path: containerPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup: context.sourceGroup }, 'gist_clone failed');
    errorResponse(context.sourceGroup, requestId, msg);
  }
};

const gistList: IpcHandler = async (data, _deps, context) => {
  const requestId = data.requestId as string | undefined;
  const rawLimit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : 10;
  const limit = Math.max(1, Math.min(rawLimit, 100));

  try {
    const { stdout } = await execFileAsync('gh', [
      'gist', 'list', '--limit', String(limit),
    ], { timeout: GH_TIMEOUT });
    // gh gist list outputs tab-separated: ID, Description, Files, Visibility, Updated
    const gists = stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [id, description, files, visibility, updated] = line.split('\t');
      return { id, description, files, visibility, updated };
    });
    respond(context.sourceGroup, requestId, { status: 'ok', gists });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup: context.sourceGroup }, 'gist_list failed');
    errorResponse(context.sourceGroup, requestId, msg);
  }
};

registerIpcHandler('gist_create', gistCreate);
registerIpcHandler('gist_view', gistView);
registerIpcHandler('gist_edit', gistEdit);
registerIpcHandler('gist_delete', gistDelete);
registerIpcHandler('gist_clone', gistClone);
registerIpcHandler('gist_list', gistList);
