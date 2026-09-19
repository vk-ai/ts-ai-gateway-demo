import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleChat, handleChatStream } from './chat.js';
import { createProvider, resolveProviderKind, type LlmProvider } from './providers/index.js';
import { loadCorpus, type CorpusChunk } from './rag/corpus.js';
import { formatSseEvent } from './sse.js';

const PORT = Number(process.env.PORT ?? 3000);
const TOP_K = Number(process.env.RAG_TOP_K ?? 3);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
}

export interface GatewayDeps {
  provider: LlmProvider;
  corpus: CorpusChunk[];
  topK?: number;
  publicDir?: string;
}

export function createGatewayServer(deps: GatewayDeps): Server {
  const topKDefault = deps.topK ?? TOP_K;
  const publicDir = deps.publicDir ?? PUBLIC_DIR;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          provider: deps.provider.name,
          chunks: deps.corpus.length,
          demo: 'oss-learning-only',
          routes: ['GET /', 'GET /health', 'POST /chat', 'POST /query', 'POST /chat/stream'],
        });
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/chat' || url.pathname === '/query')) {
        const raw = await readBody(req);
        let parsed: { message?: string; query?: string; topK?: number };
        try {
          parsed = JSON.parse(raw || '{}') as typeof parsed;
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const message = parsed.message ?? parsed.query;
        if (!message || typeof message !== 'string') {
          sendJson(res, 400, { error: 'Provide "message" or "query" string' });
          return;
        }
        const result = await handleChat(deps.provider, deps.corpus, {
          message,
          topK: parsed.topK ?? topKDefault,
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/chat/stream') {
        const raw = await readBody(req);
        let parsed: { message?: string; query?: string; topK?: number };
        try {
          parsed = JSON.parse(raw || '{}') as typeof parsed;
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const message = parsed.message ?? parsed.query;
        if (!message || typeof message !== 'string') {
          sendJson(res, 400, { error: 'Provide "message" or "query" string' });
          return;
        }

        writeSseHeaders(res);
        // Comment frame helps some proxies flush headers immediately.
        res.write(': connected\n\n');

        try {
          for await (const evt of handleChatStream(deps.provider, deps.corpus, {
            message,
            topK: parsed.topK ?? topKDefault,
          })) {
            res.write(
              formatSseEvent({
                event: evt.type,
                data: JSON.stringify(evt),
              }),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.write(
            formatSseEvent({
              event: 'error',
              data: JSON.stringify({ type: 'error', error: msg }),
            }),
          );
        }
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
        sendText(res, 200, html, 'text/html; charset=utf-8');
        return;
      }

      sendJson(res, 404, {
        error: 'Not found',
        routes: ['GET /', 'GET /health', 'POST /chat', 'POST /query', 'POST /chat/stream'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: message });
      } else {
        res.end();
      }
    }
  });
}

async function main(): Promise<void> {
  const kind = resolveProviderKind();
  const provider = createProvider(kind);
  const corpus = await loadCorpus();

  console.log(
    `[ts-ai-gateway-demo] provider=${provider.name} corpusChunks=${corpus.length} port=${PORT}`,
  );
  console.log(
    'OSS/learning portfolio demo — NOT employer production. Offline mock is the default.',
  );

  const server = createGatewayServer({ provider, corpus, topK: TOP_K });
  server.listen(PORT, () => {
    console.log(`Listening on http://localhost:${PORT}`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
