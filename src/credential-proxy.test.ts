import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./config.js', () => ({
  PROVIDER_PRIMARY: 'claude',
  PROVIDER_FAILOVER_COOLDOWN: 300_000,
  ZAI_API_KEY: '',
  ZAI_BASE_URL: 'https://api.z.ai/api/anthropic',
  ZAI_DEFAULT_MODEL: 'glm-4.5-air',
  ZAI_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
  ZAI_DEFAULT_SONNET_MODEL: 'glm-4.7',
  ZAI_DEFAULT_OPUS_MODEL: 'glm-5',
}));

import {
  startCredentialProxy,
  claudeCredentialFingerprint,
  purgeOnCredentialChange,
} from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('retries with thinking blocks stripped on 400 invalid signature', async () => {
    // Replace the default upstream with a stateful one
    await new Promise<void>((r) => upstreamServer.close(() => r()));

    let callCount = 0;
    const receivedBodies: string[] = [];

    upstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBodies.push(Buffer.concat(chunks).toString('utf8'));
        callCount++;
        if (callCount === 1) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message:
                  'messages.1.content.0: Invalid `signature` in `thinking` block',
              },
              request_id: 'req_test',
            }),
          );
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-test' });

    const requestBody = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'private thought',
              signature: 'stale-signature-from-previous-token',
            },
            { type: 'text', text: 'response' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'follow-up' }],
        },
      ],
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      requestBody,
    );

    expect(callCount).toBe(2);
    expect(receivedBodies[0]).toContain('"thinking"');
    expect(receivedBodies[1]).not.toContain('"thinking"');
    expect(res.statusCode).toBe(200);
  });

  it('does not retry on 400 errors that are not signature failures', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));

    let callCount = 0;
    upstreamServer = http.createServer((_req, res) => {
      callCount++;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'messages: text content blocks must be non-empty',
          },
        }),
      );
    });
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-test' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({ messages: [{ role: 'user', content: '' }] }),
    );

    expect(callCount).toBe(1);
    expect(res.statusCode).toBe(400);
  });

  describe('credential fingerprint', () => {
    it('produces stable fingerprints for the same credential', () => {
      const a = claudeCredentialFingerprint({
        name: 'claude',
        baseUrl: new URL('https://api.anthropic.com'),
        isHttps: true,
        authMode: 'api-key',
        apiKey: 'sk-ant-fixed',
      });
      const b = claudeCredentialFingerprint({
        name: 'claude',
        baseUrl: new URL('https://api.anthropic.com'),
        isHttps: true,
        authMode: 'api-key',
        apiKey: 'sk-ant-fixed',
      });
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    });

    it('distinguishes different credentials', () => {
      const a = claudeCredentialFingerprint({
        name: 'claude',
        baseUrl: new URL('https://api.anthropic.com'),
        isHttps: true,
        authMode: 'api-key',
        apiKey: 'sk-ant-AAA',
      });
      const b = claudeCredentialFingerprint({
        name: 'claude',
        baseUrl: new URL('https://api.anthropic.com'),
        isHttps: true,
        authMode: 'api-key',
        apiKey: 'sk-ant-BBB',
      });
      expect(a).not.toBe(b);
    });

    it('distinguishes api-key mode from oauth mode even with the same value', () => {
      const a = claudeCredentialFingerprint({
        name: 'claude',
        baseUrl: new URL('https://api.anthropic.com'),
        isHttps: true,
        authMode: 'api-key',
        apiKey: 'shared',
      });
      const b = claudeCredentialFingerprint({
        name: 'claude',
        baseUrl: new URL('https://api.anthropic.com'),
        isHttps: true,
        authMode: 'oauth',
        oauthToken: 'shared',
      });
      expect(a).not.toBe(b);
    });
  });

  describe('purgeOnCredentialChange', () => {
    let tmpDir: string;
    let fpPath: string;
    let sessionsDir: string;
    let jsonl: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-fp-'));
      fpPath = path.join(tmpDir, 'fp.json');
      sessionsDir = path.join(tmpDir, 'sessions');
      const projDir = path.join(
        sessionsDir,
        'grpA',
        '.claude',
        'projects',
        '-workspace-group',
      );
      fs.mkdirSync(projDir, { recursive: true });
      jsonl = path.join(projDir, 'sess1.jsonl');
      fs.writeFileSync(
        jsonl,
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'x', signature: 'sig' },
              { type: 'text', text: 'hi' },
            ],
          },
        }) + '\n',
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const claudeConfig = (apiKey: string) => ({
      name: 'claude' as const,
      baseUrl: new URL('https://api.anthropic.com'),
      isHttps: true,
      authMode: 'api-key' as const,
      apiKey,
    });

    it('first run records fingerprint without purging', () => {
      const r = purgeOnCredentialChange(claudeConfig('key-A'), {
        fingerprintPath: fpPath,
        sessionsDir,
      });
      expect(r.changed).toBe(false);
      expect(r.purged).toBe(0);
      // JSONL untouched
      expect(fs.readFileSync(jsonl, 'utf8')).toContain('"thinking"');
      // Fingerprint file written
      const fp = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
      expect(fp.claudeFingerprint).toMatch(/^[0-9a-f]{16}$/);
    });

    it('second run with same credential is a no-op', () => {
      purgeOnCredentialChange(claudeConfig('key-A'), {
        fingerprintPath: fpPath,
        sessionsDir,
      });
      const before = fs.readFileSync(fpPath, 'utf8');
      const r = purgeOnCredentialChange(claudeConfig('key-A'), {
        fingerprintPath: fpPath,
        sessionsDir,
      });
      expect(r.changed).toBe(false);
      expect(r.purged).toBe(0);
      expect(fs.readFileSync(fpPath, 'utf8')).toBe(before);
      expect(fs.readFileSync(jsonl, 'utf8')).toContain('"thinking"');
    });

    it('different credential triggers purge and updates fingerprint', () => {
      purgeOnCredentialChange(claudeConfig('key-A'), {
        fingerprintPath: fpPath,
        sessionsDir,
      });
      const fpBefore = JSON.parse(
        fs.readFileSync(fpPath, 'utf8'),
      ).claudeFingerprint;

      const r = purgeOnCredentialChange(claudeConfig('key-B'), {
        fingerprintPath: fpPath,
        sessionsDir,
      });
      expect(r.changed).toBe(true);
      expect(r.purged).toBe(1);
      expect(fs.readFileSync(jsonl, 'utf8')).not.toContain('"thinking"');
      const fpAfter = JSON.parse(
        fs.readFileSync(fpPath, 'utf8'),
      ).claudeFingerprint;
      expect(fpAfter).not.toBe(fpBefore);
    });

    it('skips entirely when neither api key nor oauth token is set', () => {
      const r = purgeOnCredentialChange(
        {
          name: 'claude',
          baseUrl: new URL('https://api.anthropic.com'),
          isHttps: true,
          authMode: 'oauth',
        },
        { fingerprintPath: fpPath, sessionsDir },
      );
      expect(r.changed).toBe(false);
      expect(fs.existsSync(fpPath)).toBe(false);
      expect(fs.readFileSync(jsonl, 'utf8')).toContain('"thinking"');
    });
  });

  it('does not retry on 400 signature error when body has no thinking blocks', async () => {
    await new Promise<void>((r) => upstreamServer.close(() => r()));

    let callCount = 0;
    upstreamServer = http.createServer((_req, res) => {
      callCount++;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'messages.0.content: Invalid `signature` in `thinking` block',
          },
        }),
      );
    });
    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-test' });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );

    // No retry possible — nothing to strip
    expect(callCount).toBe(1);
    expect(res.statusCode).toBe(400);
  });
});
