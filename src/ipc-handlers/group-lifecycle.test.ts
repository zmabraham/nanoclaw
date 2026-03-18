import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IpcHandler } from '../ipc-handlers.js';
import type { IpcDeps } from '../ipc.js';

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('group-lifecycle IPC handler', () => {
  let handler: IpcHandler;
  let getIpcHandler: typeof import('../ipc-handlers.js').getIpcHandler;

  beforeEach(async () => {
    vi.resetModules();
    const registry = await import('../ipc-handlers.js');
    getIpcHandler = registry.getIpcHandler;
    await import('./group-lifecycle.js');
    const resolved = getIpcHandler('unregister_group')!;
    if (!resolved) throw new Error('unregister_group handler not registered');
    handler = resolved;
  });

  const mainContext = { sourceGroup: 'main', isMain: true };
  const nonMainContext = { sourceGroup: 'child-group', isMain: false };

  function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
    return {
      sendMessage: vi.fn(),
      registeredGroups: vi.fn().mockReturnValue({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: vi.fn().mockReturnValue([]),
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
      ...overrides,
    };
  }

  it('blocks non-main groups', async () => {
    const deps = makeDeps({ unregisterGroup: vi.fn() });
    await handler({ jid: '123@s.whatsapp.net' }, deps, nonMainContext);
    expect(deps.unregisterGroup).not.toHaveBeenCalled();
  });

  it('rejects missing jid', async () => {
    const deps = makeDeps({ unregisterGroup: vi.fn() });
    await handler({}, deps, mainContext);
    expect(deps.unregisterGroup).not.toHaveBeenCalled();
  });

  it('rejects empty string jid', async () => {
    const deps = makeDeps({ unregisterGroup: vi.fn() });
    await handler({ jid: '' }, deps, mainContext);
    expect(deps.unregisterGroup).not.toHaveBeenCalled();
  });

  it('rejects non-string jid', async () => {
    const deps = makeDeps({ unregisterGroup: vi.fn() });
    await handler({ jid: 42 }, deps, mainContext);
    expect(deps.unregisterGroup).not.toHaveBeenCalled();
  });

  it('handles missing unregisterGroup dep gracefully', async () => {
    const deps = makeDeps();
    await handler({ jid: '123@s.whatsapp.net' }, deps, mainContext);
  });

  it('calls unregisterGroup and succeeds when group exists', async () => {
    const unregisterGroup = vi.fn().mockReturnValue(true);
    const deps = makeDeps({ unregisterGroup });
    await handler({ jid: '123@s.whatsapp.net' }, deps, mainContext);
    expect(unregisterGroup).toHaveBeenCalledWith('123@s.whatsapp.net');
  });

  it('calls unregisterGroup and warns when group not found', async () => {
    const unregisterGroup = vi.fn().mockReturnValue(false);
    const deps = makeDeps({ unregisterGroup });
    await handler({ jid: 'unknown@s.whatsapp.net' }, deps, mainContext);
    expect(unregisterGroup).toHaveBeenCalledWith('unknown@s.whatsapp.net');
  });
});
