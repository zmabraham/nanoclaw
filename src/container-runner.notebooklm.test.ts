import { describe, expect, it, vi } from 'vitest';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => ['--add-host=host.docker.internal:host-gateway'],
  readonlyMountArgs: () => ['--readonly'],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: () => 'api-key',
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: () => [],
}));

import { buildContainerEnvArgs, isNotebooklmLogLine, surfaceNotebooklmLog } from './container-runner.js';

describe('container-runner NotebookLM integration', () => {
  describe('buildContainerEnvArgs', () => {
    it('propagates NOTEBOOKLM_PORT and NOTEBOOKLM_HOST when set', () => {
      const args = buildContainerEnvArgs({
        NOTEBOOKLM_PORT: '12345',
        NOTEBOOKLM_HOST: 'host.docker.internal',
      });
      expect(args).toContain('NOTEBOOKLM_PORT=12345');
      expect(args).toContain('NOTEBOOKLM_HOST=host.docker.internal');
    });

    it('omits NOTEBOOKLM vars when not set', () => {
      const args = buildContainerEnvArgs({});
      expect(args.some((a) => a.startsWith('NOTEBOOKLM_'))).toBe(false);
    });
  });

  describe('isNotebooklmLogLine', () => {
    it('detects [NOTEBOOKLM] prefix', () => {
      expect(isNotebooklmLogLine('[NOTEBOOKLM] 2026-04-22 INFO ASK start')).toBe(true);
      expect(isNotebooklmLogLine('[OLLAMA] other')).toBe(false);
      expect(isNotebooklmLogLine('normal log')).toBe(false);
    });
  });

  describe('surfaceNotebooklmLog', () => {
    it('writes to the host logger when line is tagged', () => {
      const written: string[] = [];
      surfaceNotebooklmLog('[NOTEBOOKLM] ASK warm=true duration_ms=150', (msg) => written.push(msg));
      expect(written).toEqual(['[NOTEBOOKLM] ASK warm=true duration_ms=150']);
    });

    it('ignores untagged lines', () => {
      const written: string[] = [];
      surfaceNotebooklmLog('plain agent output', (msg) => written.push(msg));
      expect(written).toEqual([]);
    });
  });
});
