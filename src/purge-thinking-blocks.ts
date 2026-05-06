/**
 * Strip stale thinking-block content from persisted Claude Agent SDK session
 * JSONLs.
 *
 * The SDK stores per-group session transcripts at
 *   data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl
 *
 * Each line is one event. Assistant turns include `message.content[]` arrays
 * that may contain `{type:"thinking", thinking, signature}` blocks. The
 * `signature` is bound to the Anthropic principal that produced it; once the
 * Claude OAuth token / API key is rotated to a different account, those
 * signatures stop verifying and Anthropic returns
 *
 *   400 invalid_request_error: Invalid `signature` in `thinking` block
 *
 * on every resumed call — a cascade that bricks every group with stale
 * transcripts.
 *
 * Re-runnable, atomic per file (temp + rename), no-op for clean files.
 */
import fs from 'fs';
import path from 'path';

export interface PurgeOptions {
  sessionsDir?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface PurgeResult {
  filesScanned: number;
  filesModified: number;
  blocksRemoved: number;
  errors: Array<{ file: string; error: string }>;
}

function findJsonlFiles(sessionsDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(sessionsDir)) return out;
  for (const groupName of fs.readdirSync(sessionsDir)) {
    const projectsDir = path.join(
      sessionsDir,
      groupName,
      '.claude',
      'projects',
    );
    if (!fs.existsSync(projectsDir)) continue;
    for (const projDir of fs.readdirSync(projectsDir)) {
      const full = path.join(projectsDir, projDir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const entry of fs.readdirSync(full)) {
        if (entry.endsWith('.jsonl')) out.push(path.join(full, entry));
      }
    }
  }
  return out;
}

function purgeFile(
  file: string,
  dryRun: boolean,
): { modified: boolean; blocksRemoved: number } {
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n');
  let blocksRemoved = 0;
  let modified = false;

  const out: string[] = [];
  for (const line of lines) {
    if (!line) {
      out.push(line);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Leave malformed lines alone — better than rewriting them.
      out.push(line);
      continue;
    }
    const obj = parsed as { message?: { content?: unknown } };
    const content = obj?.message?.content;
    if (!Array.isArray(content)) {
      out.push(line);
      continue;
    }
    const filtered = content.filter(
      (b: { type?: string }) => b?.type !== 'thinking',
    );
    if (filtered.length === content.length) {
      out.push(line);
      continue;
    }
    blocksRemoved += content.length - filtered.length;
    (obj.message as { content: unknown }).content = filtered;
    modified = true;
    out.push(JSON.stringify(obj));
  }

  if (modified && !dryRun) {
    const tmp = file + '.purge-tmp';
    fs.writeFileSync(tmp, out.join('\n'));
    const fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  }

  return { modified, blocksRemoved };
}

export function purgeThinkingBlocks(opts: PurgeOptions = {}): PurgeResult {
  const sessionsDir =
    opts.sessionsDir ?? path.join(process.cwd(), 'data', 'sessions');
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => {});

  const files = findJsonlFiles(sessionsDir);
  const result: PurgeResult = {
    filesScanned: files.length,
    filesModified: 0,
    blocksRemoved: 0,
    errors: [],
  };

  for (const file of files) {
    try {
      const { modified, blocksRemoved } = purgeFile(file, dryRun);
      if (modified) {
        result.filesModified++;
        result.blocksRemoved += blocksRemoved;
        log(
          `${dryRun ? '[dry-run] would strip' : 'stripped'} ${blocksRemoved} thinking block(s) from ${file}`,
        );
      }
    } catch (err) {
      result.errors.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
