import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Tests for the whitelist_edit IPC handler's defensive surface:
 * - Path-traversal sanitization on requestId
 * - Main-gated authorization (non-main senders refused)
 * - add_auto_approved blocked when subject is in always_ask
 */

describe('whitelist-edit handler — requestId traversal', () => {
  let tmpDir: string;
  let configDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whitelist-test-'));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whitelist-cfg-'));
    process.chdir(tmpDir);

    // Seed a valid whitelist config
    fs.writeFileSync(
      path.join(configDir, 'intercom-whitelist.json'),
      JSON.stringify({
        groups: { 'group-a': { intercom: true, auto_approved: [] } },
        always_ask: ['dangerous-subject'],
        expired_retention_days: 30,
      }),
    );

    vi.resetModules();
    // Mock CONFIG_PATH to point at our tmp copy
    vi.doMock('../intercom-whitelist.js', () => ({
      CONFIG_PATH: path.join(configDir, 'intercom-whitelist.json'),
    }));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock('../intercom-whitelist.js');
  });

  it('refuses requestId containing path traversal', async () => {
    const { getIpcHandler } = await import('../ipc-handlers.js');
    await import('./whitelist-edit.js'); // side-effect register
    const handler = getIpcHandler('whitelist_edit')!;
    expect(handler).toBeDefined();

    await handler(
      {
        requestId: '../evil',
        action: 'add_group',
        group: 'new-group',
      } as Record<string, unknown>,
      {} as never,
      { sourceGroup: 'main', isMain: true },
    );

    // Nothing should have been written to data/ipc under tmpDir for main
    const responsesDir = path.join(tmpDir, 'data', 'ipc', 'main', 'responses');
    // Either the dir was never created, or it exists but is empty of
    // any response file that leaked outside.
    if (fs.existsSync(responsesDir)) {
      const entries = fs.readdirSync(responsesDir);
      // No traversal artefacts
      expect(entries.every((e) => !e.startsWith('..'))).toBe(true);
    }
    // Absolutely no file at '../evil.json' relative to responsesDir
    const escapeFile = path.join(tmpDir, 'data', 'ipc', 'main', 'evil.json');
    expect(fs.existsSync(escapeFile)).toBe(false);
  });

  it('refuses whitelist_edit when context.isMain is false', async () => {
    const { getIpcHandler } = await import('../ipc-handlers.js');
    await import('./whitelist-edit.js');
    const handler = getIpcHandler('whitelist_edit')!;

    // Record what the handler writes as a response
    await handler(
      {
        requestId: 'req-1',
        action: 'add_group',
        group: 'sneaky',
      } as Record<string, unknown>,
      {} as never,
      { sourceGroup: 'group-a', isMain: false },
    );

    // Config must not have been mutated
    const cfg = JSON.parse(
      fs.readFileSync(path.join(configDir, 'intercom-whitelist.json'), 'utf-8'),
    );
    expect(cfg.groups.sneaky).toBeUndefined();
  });

  it('blocks add_auto_approved when subject is in always_ask', async () => {
    const { getIpcHandler } = await import('../ipc-handlers.js');
    await import('./whitelist-edit.js');
    const handler = getIpcHandler('whitelist_edit')!;

    await handler(
      {
        requestId: 'req-2',
        action: 'add_auto_approved',
        group: 'group-a',
        subject: 'dangerous-subject',
      } as Record<string, unknown>,
      {} as never,
      { sourceGroup: 'main', isMain: true },
    );

    // Subject was in always_ask — should not have been added to auto_approved
    const cfg = JSON.parse(
      fs.readFileSync(path.join(configDir, 'intercom-whitelist.json'), 'utf-8'),
    );
    expect(cfg.groups['group-a'].auto_approved).not.toContain(
      'dangerous-subject',
    );
  });
});
