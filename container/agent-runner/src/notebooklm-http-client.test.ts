import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAsk, callList, callSearch, DaemonError } from './notebooklm-http-client.js';

describe('notebooklm HTTP client (daemon calls)', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.NOTEBOOKLM_PORT = '11999';
    delete process.env.NOTEBOOKLM_HOST;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('callAsk POSTs to /ask on host.docker.internal', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://host.docker.internal:11999/ask');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.question).toBe('what is X?');
      expect(body.notebook_id).toBe('nb1');
      return new Response(
        JSON.stringify({ answer: 'A', citations: [], notebook: { id: 'nb1' }, warm_hit: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const out = await callAsk({ question: 'what is X?', notebook_id: 'nb1' });
    expect(out.answer).toBe('A');
    expect(out.warm_hit).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('callAsk surfaces daemon HTTP errors with structured hint', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'notebook not found', hint: 'use notebooklm_list' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const err = await callAsk({ question: 'q' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonError);
    expect((err as DaemonError).message).toContain('notebook not found');
    expect((err as DaemonError).hint).toBe('use notebooklm_list');
  });

  it('callList GETs /list', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('http://host.docker.internal:11999/list');
      return new Response(JSON.stringify({ notebooks: [{ id: 'nb1' }] }), { status: 200 });
    }) as typeof fetch;
    const res = await callList();
    expect(res.notebooks).toHaveLength(1);
  });

  it('callSearch GETs /search with url-encoded query', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('http://host.docker.internal:11999/search?q=quantum%20physics');
      return new Response(JSON.stringify({ notebooks: [] }), { status: 200 });
    }) as typeof fetch;
    await callSearch({ query: 'quantum physics' });
  });
});
