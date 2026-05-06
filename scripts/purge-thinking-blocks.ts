#!/usr/bin/env tsx
/**
 * CLI for src/purge-thinking-blocks.ts. See that module for full background.
 *
 *   tsx scripts/purge-thinking-blocks.ts [--dry-run] [--dir <path>]
 *
 * Library use: import from `src/purge-thinking-blocks.ts` directly. The
 * credential proxy invokes it automatically on Claude-credential changes —
 * this CLI is for ad-hoc / recovery runs.
 */
import path from 'path';
import { purgeThinkingBlocks } from '../src/purge-thinking-blocks.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dirIdx = args.indexOf('--dir');
const sessionsDir =
  dirIdx >= 0 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : undefined;

const result = purgeThinkingBlocks({
  sessionsDir,
  dryRun,
  log: (m) => console.log(`[purge-thinking-blocks] ${m}`),
});

console.log(
  `[purge-thinking-blocks] scanned=${result.filesScanned} modified=${result.filesModified} blocks_removed=${result.blocksRemoved} errors=${result.errors.length}${dryRun ? ' (dry-run)' : ''}`,
);
for (const e of result.errors) {
  console.error(`[purge-thinking-blocks] ERROR ${e.file}: ${e.error}`);
}
if (result.errors.length > 0) process.exit(1);
