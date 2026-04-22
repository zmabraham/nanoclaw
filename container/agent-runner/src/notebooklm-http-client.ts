/**
 * NotebookLM HTTP client.
 *
 * Pure fetch wrappers for the host daemon on
 *   http://${NOTEBOOKLM_HOST | host.docker.internal}:${NOTEBOOKLM_PORT | 11435}
 *
 * Deliberately has NO MCP SDK imports so root-level vitest can load and
 * test it without the SDK being installed in the repo root.
 */
function baseUrl(): string {
  const host = process.env.NOTEBOOKLM_HOST || 'host.docker.internal';
  const port = process.env.NOTEBOOKLM_PORT || '11435';
  return `http://${host}:${port}`;
}

export class DaemonError extends Error {
  public readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(hint ? `${message} (hint: ${hint})` : message);
    this.hint = hint;
  }
}

async function daemonJson(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* keep empty */ }
  if (!resp.ok) {
    const err = typeof body.error === 'string' ? body.error : `HTTP ${resp.status}`;
    const hint = typeof body.hint === 'string' ? body.hint : undefined;
    throw new DaemonError(err, hint);
  }
  return body;
}

export interface AskArgs { question: string; notebook_id?: string; notebook_url?: string; }
export interface AskResponse {
  answer: string;
  citations: unknown[];
  notebook: { id?: string; name?: string; url?: string };
  warm_hit: boolean;
}

export async function callAsk(args: AskArgs): Promise<AskResponse> {
  const resp = await fetch(`${baseUrl()}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  return (await daemonJson(resp)) as unknown as AskResponse;
}

export async function callList(): Promise<{ notebooks: unknown[] }> {
  const resp = await fetch(`${baseUrl()}/list`);
  return (await daemonJson(resp)) as unknown as { notebooks: unknown[] };
}

export async function callSearch(args: { query: string }): Promise<{ notebooks: unknown[] }> {
  const url = `${baseUrl()}/search?q=${encodeURIComponent(args.query)}`;
  const resp = await fetch(url);
  return (await daemonJson(resp)) as unknown as { notebooks: unknown[] };
}
