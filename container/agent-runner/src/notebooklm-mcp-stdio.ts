/**
 * NotebookLM MCP stdio bridge — entry point.
 *
 * Launched by agent-runner as a subprocess (stdio transport). Imports
 * the MCP SDK (resolved from container/agent-runner/node_modules at
 * runtime) and the test-covered HTTP client. This file is NEVER
 * imported by vitest — tests live against notebooklm-http-client.ts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { callAsk, callList, callSearch } from './notebooklm-http-client.js';

const server = new McpServer({ name: 'notebooklm', version: '1.0.0' });

server.tool(
  'notebooklm_ask',
  'Ask a question of a private Google NotebookLM notebook. Returns a source-grounded answer with citations. Prefer passing notebook_id over notebook_url when both are known — id wins if both are provided.',
  {
    question: z.string().describe('The question to ask the notebook.'),
    notebook_id: z.string().optional().describe('Notebook id from notebooklm_list.'),
    notebook_url: z.string().optional().describe('Direct NotebookLM URL; used when id is unknown.'),
  },
  async (args) => {
    const out = await callAsk(args);
    const text = [
      out.answer,
      out.citations.length ? `\n\nCitations:\n${JSON.stringify(out.citations, null, 2)}` : '',
      `\n\n(notebook=${out.notebook.name || out.notebook.id || out.notebook.url}, warm_hit=${out.warm_hit})`,
    ].join('');
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'notebooklm_list',
  'List notebooks in the local NotebookLM library with their ids, names, descriptions, and topics.',
  {},
  async () => {
    const out = await callList();
    return { content: [{ type: 'text' as const, text: JSON.stringify(out.notebooks, null, 2) }] };
  },
);

server.tool(
  'notebooklm_search',
  'Search the local NotebookLM library by topic/keyword. Returns matching notebooks with their metadata.',
  { query: z.string().describe('Search term to match against topics, names, and descriptions.') },
  async (args) => {
    const out = await callSearch(args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(out.notebooks, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
