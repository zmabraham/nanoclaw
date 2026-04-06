import express, { Request, Response } from 'express';
import { loadConfig, getConfig } from './config.js';
import { qdrantClient } from './database/qdrant-client.js';
import { initialize as initEmbeddings, embed } from './embeddings.js';
import {
  runBackfillIfNeeded,
  runIngestionCycle,
} from './ingestion.js';
import { akiflowSearch } from './akiflow-search.js';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const app = express();

app.use(express.json({ limit: '16kb' }));

interface SearchRequest {
  query: string;
  filters?: {
    groups?: string[];
    senders?: string[];
    dateRange?: {
      start?: string;
      end?: string;
    };
  };
  limit?: number;
  scoreThreshold?: number;
}

interface SearchResult {
  message: {
    id: string;
    content: string;
    sender: string;
    sender_name: string;
    timestamp: string;
    group_name?: string;
    chat_jid: string;
  };
  similarity: number;
}

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', service: 'Message Search RAG API' });
});

// Search endpoint
app.post('/api/search', async (req: Request, res: Response) => {
  try {
    const searchReq: SearchRequest = req.body;

    if (!searchReq.query || typeof searchReq.query !== 'string') {
      res.status(400).json({ error: 'query field is required' });
      return;
    }

    if (searchReq.query.length > 2000) {
      res.status(400).json({ error: 'query too long (max 2000 chars)' });
      return;
    }

    const config = getConfig();

    console.log(`Searching for: "${searchReq.query}"`);
    const queryVector = await embed(searchReq.query);

    const filters: any = {};

    if (searchReq.filters?.groups) {
      filters.group_name = searchReq.filters.groups;
    }

    if (searchReq.filters?.senders) {
      filters.sender = searchReq.filters.senders;
    }

    if (searchReq.filters?.dateRange?.start) {
      filters.startDate = searchReq.filters.dateRange.start;
    }

    if (searchReq.filters?.dateRange?.end) {
      filters.endDate = searchReq.filters.dateRange.end;
    }

    const limit = Math.min(Math.max(Math.trunc(searchReq.limit || config.search.topK), 1), 100);
    const scoreThreshold = Math.min(Math.max(
      searchReq.scoreThreshold ?? config.search.scoreThreshold, 0), 1);

    const qdrantResults = await qdrantClient.searchSimilar(
      queryVector,
      filters,
      limit,
      scoreThreshold,
    );

    const results: SearchResult[] = qdrantResults.map((result) => ({
      message: {
        id: result.payload.message_id,
        content: result.payload.content,
        sender: result.payload.sender,
        sender_name: result.payload.sender_name,
        timestamp: result.payload.timestamp,
        group_name: result.payload.group_name,
        chat_jid: result.payload.chat_jid,
      },
      similarity: result.score,
    }));

    console.log(`Found ${results.length} results`);

    res.json({
      query: searchReq.query,
      results,
      totalResults: results.length,
      filters: searchReq.filters,
    });
  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Akiflow entity search (tasks + events) — hybrid vector + keyword
app.post('/api/akiflow/search', async (req: Request, res: Response) => {
  try {
    const { query, filters, limit } = req.body;
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query field is required' });
      return;
    }
    const openai = new (await import('openai')).default({
      apiKey: process.env.OPENAI_API_KEY,
    });
    const akiflowDbPath = process.env.AKIFLOW_DB_PATH
      || path.join(process.cwd(), '..', 'akiflow', 'akiflow.db');
    let db: Database.Database | null = null;
    if (fs.existsSync(akiflowDbPath)) {
      db = new Database(akiflowDbPath, { readonly: true });
      db.pragma('busy_timeout = 3000');
    }
    try {
      const result = await akiflowSearch(
        qdrantClient.getClient(),
        openai,
        db,
        { query, filters, limit },
      );
      res.json(result);
    } finally {
      db?.close();
    }
  } catch (error: any) {
    console.error('Akiflow search error:', error);
    res.status(500).json({ error: 'Akiflow search failed' });
  }
});

// Stats endpoint
app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    const collectionInfo = await qdrantClient.getCollectionInfo();

    res.json({
      vectorsIndexed: collectionInfo.points_count,
      vectorSize: collectionInfo.config.params.vectors.size,
      status: collectionInfo.status,
    });
  } catch (error: any) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// Manual ingestion trigger
app.post('/api/ingest', async (_req: Request, res: Response) => {
  try {
    await runIngestionCycle();
    const collectionInfo = await qdrantClient.getCollectionInfo();
    res.json({
      status: 'ok',
      vectorsIndexed: collectionInfo.points_count,
    });
  } catch (error: any) {
    console.error('Ingestion error:', error);
    res.status(500).json({ error: 'Ingestion failed' });
  }
});

// Start server
let ingestionTimer: ReturnType<typeof setInterval> | null = null;
let socketServer: ReturnType<typeof app.listen> | null = null;

async function startServer() {
  try {
    loadConfig();
    const config = getConfig();

    console.log('Initializing services...');
    initEmbeddings();
    await qdrantClient.initializeCollection();

    // Run backfill (no-op if watermark exists) then initial ingestion
    await runBackfillIfNeeded();
    await runIngestionCycle();

    // Start periodic ingestion
    ingestionTimer = setInterval(
      () => runIngestionCycle(),
      config.ingestion.pollIntervalMs,
    );
    console.log(
      `Periodic ingestion every ${config.ingestion.pollIntervalMs / 1000}s`,
    );

    const { port, host, socketPath } = config.server;

    app.listen(port, host, () => {
      console.log(`\nMessage Search RAG API running on http://${host}:${port}`);
      console.log(`  Health: GET /health`);
      console.log(`  Search:  POST /api/search`);
      console.log(`  Akiflow: POST /api/akiflow/search`);
      console.log(`  Stats:   GET /api/stats`);
      console.log(`  Ingest:  POST /api/ingest`);
    });

    // Unix socket listener for container access (main-only via mount gating)
    if (socketPath) {
      const resolvedSocketPath = path.resolve(socketPath);
      // Clean up stale socket from previous run
      try { fs.unlinkSync(resolvedSocketPath); } catch {}
      fs.mkdirSync(path.dirname(resolvedSocketPath), { recursive: true });

      socketServer = app.listen(resolvedSocketPath, () => {
        console.log(`  Socket: ${resolvedSocketPath}\n`);
      });
    } else {
      console.log('');
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  if (ingestionTimer) clearInterval(ingestionTimer);
  if (socketServer) {
    socketServer.close();
    const config = getConfig();
    if (config.server.socketPath) {
      try { fs.unlinkSync(path.resolve(config.server.socketPath)); } catch {}
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();
