/**
 * Credential proxy for container isolation with dual-provider failover.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Supports two Anthropic-compatible providers (Claude + ZAI/GLM):
 *   - Routes to the active provider's base URL with its credentials
 *   - On HTTP 429, switches to the other provider and retries
 *   - Cooldown prevents flapping back too quickly
 *
 * Auth modes per provider:
 *   Claude API key:  injects x-api-key
 *   Claude OAuth:    replaces placeholder Bearer token
 *   ZAI:             injects x-api-key
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { purgeThinkingBlocks } from './purge-thinking-blocks.js';
import {
  PROVIDER_PRIMARY,
  PROVIDER_FAILOVER_COOLDOWN,
  ZAI_API_KEY,
  ZAI_BASE_URL,
  type ProviderName,
} from './config.js';

export type AuthMode = 'api-key' | 'oauth';

interface ProviderConfig {
  name: ProviderName;
  baseUrl: URL;
  isHttps: boolean;
  authMode: AuthMode;
  apiKey?: string;
  oauthToken?: string;
}

let activeProvider: ProviderName = PROVIDER_PRIMARY;
let failoverTimer: ReturnType<typeof setTimeout> | null = null;

function loadProviders(): { claude: ProviderConfig; zai: ProviderConfig } {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const claudeUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );

  const claudeAuthMode: AuthMode = secrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : 'oauth';

  const zaiUrl = new URL(ZAI_BASE_URL);

  return {
    claude: {
      name: 'claude',
      baseUrl: claudeUrl,
      isHttps: claudeUrl.protocol === 'https:',
      authMode: claudeAuthMode,
      apiKey: secrets.ANTHROPIC_API_KEY || undefined,
      oauthToken:
        secrets.CLAUDE_CODE_OAUTH_TOKEN ||
        secrets.ANTHROPIC_AUTH_TOKEN ||
        undefined,
    },
    zai: {
      name: 'zai',
      baseUrl: zaiUrl,
      isHttps: zaiUrl.protocol === 'https:',
      authMode: 'api-key',
      apiKey: ZAI_API_KEY || undefined,
    },
  };
}

function getActiveConfig(providers: {
  claude: ProviderConfig;
  zai: ProviderConfig;
}): ProviderConfig {
  return providers[activeProvider];
}

function switchProvider(
  from: ProviderName,
  providers: { claude: ProviderConfig; zai: ProviderConfig },
): void {
  const to: ProviderName = from === 'claude' ? 'zai' : 'claude';
  const target = providers[to];

  if (
    (target.authMode === 'api-key' && !target.apiKey) ||
    (target.authMode === 'oauth' && !target.oauthToken)
  ) {
    logger.warn(
      { to, authMode: target.authMode },
      'Failover target has no credentials, skipping switch',
    );
    return;
  }

  activeProvider = to;
  logger.warn(
    { from, to, cooldownMs: PROVIDER_FAILOVER_COOLDOWN },
    'Provider switched due to rate limit',
  );

  if (failoverTimer) clearTimeout(failoverTimer);
  failoverTimer = setTimeout(() => {
    activeProvider = PROVIDER_PRIMARY;
    logger.info(
      { primary: PROVIDER_PRIMARY },
      'Failover cooldown expired, reverted to primary provider',
    );
    failoverTimer = null;
  }, PROVIDER_FAILOVER_COOLDOWN);
}

function injectCredentials(
  headers: Record<string, string | number | string[] | undefined>,
  config: ProviderConfig,
): void {
  if (config.authMode === 'api-key') {
    delete headers['x-api-key'];
    delete headers['authorization'];
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }
  } else {
    // OAuth: only replace Authorization when the container actually sends
    // one (exchange request + auth probes). Post-exchange traffic uses an
    // x-api-key obtained from the exchange, which must pass through.
    if (headers['authorization']) {
      delete headers['authorization'];
      if (config.oauthToken) {
        headers['authorization'] = `Bearer ${config.oauthToken}`;
      }
    }
  }
}

/**
 * Strip thinking blocks from message content when crossing provider boundaries.
 * Thinking blocks carry signatures bound to the originating Anthropic principal;
 * other providers and rotated Claude credentials reject them as invalid.
 *
 * Returns the same buffer reference if nothing was stripped (callers rely on
 * `result !== body` to detect modification and avoid pointless retries).
 */
export function stripThinkingBlocks(body: Buffer): Buffer {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed.messages || !Array.isArray(parsed.messages)) return body;

    let modified = false;
    for (const msg of parsed.messages) {
      if (!Array.isArray(msg.content)) continue;
      const filtered = msg.content.filter(
        (block: { type?: string }) => block.type !== 'thinking',
      );
      if (filtered.length !== msg.content.length) {
        msg.content = filtered;
        modified = true;
      }
    }

    if (modified) {
      const json = JSON.stringify(parsed);
      return Buffer.from(json, 'utf8');
    }
    return body;
  } catch {
    return body;
  }
}

/**
 * Decode an HTTP response body according to its `content-encoding`. Returns
 * the original buffer for `identity`, missing, or unrecognized encodings —
 * the caller then falls back to substring-matching raw bytes.
 */
function decodeResponseBody(
  body: Buffer,
  contentEncoding: string | string[] | undefined,
): Buffer {
  if (!contentEncoding) return body;
  const enc = Array.isArray(contentEncoding)
    ? contentEncoding[0]
    : contentEncoding;
  try {
    switch (enc.toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(body);
      case 'deflate':
        return zlib.inflateSync(body);
      case 'br':
        return zlib.brotliDecompressSync(body);
      default:
        return body;
    }
  } catch {
    return body;
  }
}

/**
 * Detect Anthropic's "Invalid `signature` in `thinking` block" 400 response.
 * Matches the literal backtick-quoted error text Anthropic emits when the
 * thinking-block signature can't be verified under the active principal.
 */
export function isThinkingSignatureError(responseBody: Buffer): boolean {
  // Cheap substring check first — avoids parsing every 400 we ever proxy.
  const text = responseBody.toString('utf8');
  if (!text.includes('Invalid `signature`')) return false;
  if (!text.includes('thinking')) return false;
  try {
    const parsed = JSON.parse(text);
    return (
      parsed?.type === 'error' &&
      parsed?.error?.type === 'invalid_request_error' &&
      typeof parsed?.error?.message === 'string' &&
      parsed.error.message.includes('Invalid `signature`')
    );
  } catch {
    return false;
  }
}

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  config: ProviderConfig,
): Promise<number> {
  return sendUpstream(req, res, body, config, /* retriesLeft */ 1);
}

function sendUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  config: ProviderConfig,
  retriesLeft: number,
): Promise<number> {
  return new Promise((resolve) => {
    // Strip thinking blocks when routing to non-Claude provider (signatures are provider-specific)
    const finalBody =
      config.name !== 'claude' ? stripThinkingBlocks(body) : body;

    const headers: Record<string, string | number | string[] | undefined> = {
      ...(req.headers as Record<string, string>),
      host: config.baseUrl.host,
      'content-length': finalBody.length,
    };

    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    injectCredentials(headers, config);

    const basePath = config.baseUrl.pathname.replace(/\/+$/, '');
    const proxyPath = basePath + req.url;

    const makeRequest = config.isHttps ? httpsRequest : httpRequest;
    const upstream = makeRequest(
      {
        hostname: config.baseUrl.hostname,
        port: config.baseUrl.port || (config.isHttps ? 443 : 80),
        path: proxyPath,
        method: req.method,
        headers,
      } as RequestOptions,
      (upRes) => {
        const status = upRes.statusCode || 500;

        // Buffer 400 responses so we can inspect for the
        // "Invalid `signature` in `thinking` block" cascade and retry once
        // with stale thinking blocks removed. Stream everything else.
        if (status === 400 && retriesLeft > 0) {
          const chunks: Buffer[] = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', async () => {
            const respBody = Buffer.concat(chunks);
            // Anthropic returns 4xx with `content-encoding: gzip`; substring
            // matching only works against decoded bytes. Forward the
            // original encoded buffer to the client unchanged either way.
            const decoded = decodeResponseBody(
              respBody,
              upRes.headers['content-encoding'],
            );
            if (isThinkingSignatureError(decoded)) {
              const stripped = stripThinkingBlocks(finalBody);
              if (stripped !== finalBody) {
                logger.warn(
                  {
                    provider: config.name,
                    url: req.url,
                    bodyLen: finalBody.length,
                    strippedLen: stripped.length,
                  },
                  'Thinking-block signature rejected by upstream — retrying with stripped body',
                );
                const retryStatus = await sendUpstream(
                  req,
                  res,
                  stripped,
                  config,
                  retriesLeft - 1,
                );
                resolve(retryStatus);
                return;
              }
            }
            // Not retrying — surface the 400 to the client unchanged.
            if (!res.headersSent) {
              res.writeHead(status, upRes.headers);
              res.end(respBody);
            }
            resolve(status);
          });
          return;
        }

        resolve(status);
        res.writeHead(status, upRes.headers);

        // For non-Claude providers, rewrite the model name in responses so
        // the SDK doesn't reject unknown models like "glm-4.7".
        if (
          config.name !== 'claude' &&
          upRes.headers['content-type']?.includes('text/event-stream')
        ) {
          upRes.on('data', (chunk) => {
            res.write(rewriteStreamChunk(chunk));
          });
          upRes.on('end', () => res.end());
        } else if (
          config.name !== 'claude' &&
          upRes.headers['content-type']?.includes('application/json')
        ) {
          const chunks: Buffer[] = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            res.end(rewriteJsonModel(Buffer.concat(chunks)));
          });
        } else {
          upRes.pipe(res);
        }
      },
    );

    const UPSTREAM_TIMEOUT_MS = 120_000; // 2 minutes — covers large agent sessions
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      logger.warn(
        { url: req.url, provider: config.name, timeoutMs: UPSTREAM_TIMEOUT_MS },
        'Upstream request timed out, aborting',
      );
      upstream.destroy(
        new Error(`Upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`),
      );
    });

    upstream.on('error', (err) => {
      logger.error(
        { err, url: req.url, provider: config.name },
        'Upstream error',
      );
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
      resolve(502);
    });

    upstream.write(finalBody);
    upstream.end();
  });
}

let toolIdCounter = 0;

/**
 * Rewrite ZAI-incompatible fields in SSE streaming chunks to Claude-compatible ones.
 * ZAI returns: model "glm-...", server_tool_use ids like "call_abc123",
 * tool name "web_search_prime" instead of "web_search".
 */
function rewriteStreamChunk(chunk: Buffer): Buffer {
  const text = chunk.toString('utf8');
  let rewritten = text;
  // Model name
  rewritten = rewritten.replace(
    /"model"\s*:\s*"glm-[^"]+"/g,
    '"model":"claude-sonnet-4-6"',
  );
  // server_tool_use id — replace non-srvtoolu IDs with valid ones
  rewritten = rewritten.replace(
    /"id"\s*:\s*"((?!srvtoolu_)[^"]+)"/g,
    (_, id) => {
      toolIdCounter++;
      return `"id":"srvtoolu_zai_${toolIdCounter.toString(36)}"`;
    },
  );
  // tool_use_id references must also be rewritten
  rewritten = rewritten.replace(
    /"tool_use_id"\s*:\s*"((?!srvtoolu_)[^"]+)"/g,
    (_, id) => `"tool_use_id":"srvtoolu_zai_${toolIdCounter.toString(36)}"`,
  );
  return rewritten === text ? chunk : Buffer.from(rewritten, 'utf8');
}

/** Rewrite ZAI-incompatible fields in a non-streaming JSON response. */
function rewriteJsonModel(body: Buffer): Buffer {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    let modified = false;

    if (
      parsed.model &&
      typeof parsed.model === 'string' &&
      parsed.model.startsWith('glm-')
    ) {
      parsed.model = 'claude-sonnet-4-6';
      modified = true;
    }

    // Rewrite server_tool_use / tool_result IDs and content array
    if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (
          block.type === 'server_tool_use' &&
          block.id &&
          !block.id.startsWith('srvtoolu_')
        ) {
          toolIdCounter++;
          const newId = `srvtoolu_zai_${toolIdCounter.toString(36)}`;
          const oldId = block.id;
          block.id = newId;
          // Fix any tool_result references to the old ID
          for (const b2 of parsed.content) {
            if (b2.type === 'tool_result' && b2.tool_use_id === oldId) {
              b2.tool_use_id = newId;
            }
          }
          modified = true;
        }
      }
    }

    if (modified) {
      const json = JSON.stringify(parsed);
      return Buffer.from(json, 'utf8');
    }
  } catch {
    /* not JSON or unparseable — pass through */
  }
  return body;
}

/**
 * Fingerprint of the active Claude credential — used to detect token rotation
 * across runs. Truncated SHA-256, no recoverable secret material.
 */
export function claudeCredentialFingerprint(claude: ProviderConfig): string {
  const material =
    claude.authMode === 'api-key'
      ? `api-key:${claude.apiKey ?? ''}`
      : `oauth:${claude.oauthToken ?? ''}`;
  return crypto
    .createHash('sha256')
    .update(material)
    .digest('hex')
    .slice(0, 16);
}

/**
 * If the active Claude credential differs from the one persisted on the last
 * successful startup, scrub stale thinking blocks from session JSONLs and
 * record the new fingerprint. First-ever run is a no-op (just records).
 */
export function purgeOnCredentialChange(
  claude: ProviderConfig,
  opts: { fingerprintPath?: string; sessionsDir?: string } = {},
): { changed: boolean; purged: number } {
  if (!claude.apiKey && !claude.oauthToken)
    return { changed: false, purged: 0 };

  const fpPath =
    opts.fingerprintPath ??
    path.join(process.cwd(), 'data', 'credential-fingerprint.json');
  const fingerprint = claudeCredentialFingerprint(claude);

  let prev: string | undefined;
  try {
    if (fs.existsSync(fpPath)) {
      const raw = fs.readFileSync(fpPath, 'utf8');
      prev = JSON.parse(raw)?.claudeFingerprint;
    }
  } catch (err) {
    logger.warn({ err, fpPath }, 'Failed to read credential fingerprint');
  }

  if (prev === fingerprint) return { changed: false, purged: 0 };

  let purgedBlocks = 0;
  if (prev) {
    logger.warn(
      { previous: prev, current: fingerprint },
      'Claude credential changed since last run — purging stale thinking blocks',
    );
    const result = purgeThinkingBlocks({
      sessionsDir: opts.sessionsDir,
      log: (m) => logger.info({ purge: m }, 'purge-thinking-blocks'),
    });
    purgedBlocks = result.blocksRemoved;
    logger.info(
      {
        scanned: result.filesScanned,
        modified: result.filesModified,
        blocksRemoved: result.blocksRemoved,
        errors: result.errors.length,
      },
      'Thinking-block purge complete',
    );
  } else {
    logger.info(
      { fingerprint },
      'No previous credential fingerprint — recording current',
    );
  }

  try {
    fs.mkdirSync(path.dirname(fpPath), { recursive: true });
    fs.writeFileSync(
      fpPath,
      JSON.stringify({ claudeFingerprint: fingerprint }, null, 2) + '\n',
    );
  } catch (err) {
    logger.error({ err, fpPath }, 'Failed to persist credential fingerprint');
  }

  return { changed: prev !== undefined, purged: purgedBlocks };
}

/**
 * Production entry point for the credential-change check. The host calls this
 * once at startup, before `startCredentialProxy`, to detect Claude token
 * rotation and scrub stale thinking blocks. Kept separate from
 * `startCredentialProxy` so tests can spin up the proxy without touching the
 * real fingerprint file.
 */
export function runCredentialChangeCheck(opts?: {
  fingerprintPath?: string;
  sessionsDir?: string;
}): { changed: boolean; purged: number } {
  return purgeOnCredentialChange(loadProviders().claude, opts);
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const providers = loadProviders();

  logger.info(
    {
      primary: PROVIDER_PRIMARY,
      claude: {
        url: providers.claude.baseUrl.href,
        authMode: providers.claude.authMode,
        hasKey: !!providers.claude.apiKey || !!providers.claude.oauthToken,
      },
      zai: {
        url: providers.zai.baseUrl.href,
        hasKey: !!providers.zai.apiKey,
      },
    },
    'Dual-provider credential proxy configured',
  );

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const config = getActiveConfig(providers);

        const statusCode = await proxyRequest(req, res, body, config);

        // On 429, 401, or 502 (upstream timeout), switch to the other provider
        if (statusCode === 429 || statusCode === 401 || statusCode === 502) {
          const prevProvider = config.name;
          switchProvider(prevProvider, providers);
          logger.info(
            {
              from: prevProvider,
              to: activeProvider,
              url: req.url,
              statusCode,
            },
            `${statusCode} received, provider switched for subsequent requests`,
          );
        }

        // Log 400 errors for debugging thinking-block signature issues
        if (statusCode === 400) {
          const bodyStr = body.toString('utf8');
          const hasThinking = bodyStr.includes('"thinking"');
          const msgCount = (bodyStr.match(/"role"/g) || []).length;
          logger.warn(
            {
              url: req.url,
              provider: config.name,
              hasThinking,
              msgCount,
              bodyLen: body.length,
            },
            '400 response from upstream',
          );
        }
      });
    });

    server.listen(port, host, () => {
      logger.info(
        {
          port,
          host,
          activeProvider,
          authMode: getActiveConfig(providers).authMode,
        },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Reset the active provider to primary and clear any failover timer. */
export function resetProvider(): void {
  if (failoverTimer) {
    clearTimeout(failoverTimer);
    failoverTimer = null;
  }
  activeProvider = PROVIDER_PRIMARY;
}

/** Detect which auth mode the host is configured for (Claude provider). */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/** Get the currently active provider name. */
export function getActiveProvider(): ProviderName {
  return activeProvider;
}
