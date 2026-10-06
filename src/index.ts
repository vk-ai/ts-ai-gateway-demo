import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPLETION_MAX_TOKENS, estimatePromptTokens, handleChat, handleChatStream } from './chat.js';
import { createProviderFromEnv, FallbackError, type LlmProvider } from './providers/index.js';
import { loadCorpus, type CorpusChunk } from './rag/corpus.js';
import { apiKeyFrom, createQuotasFromEnv, estimateTokens, type KeyQuotas, type Reservation } from './quota.js';
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

const CORS_ALLOW_HEADERS = 'Content-Type, x-api-key, Authorization';
const CORS_EXPOSE_HEADERS =
  'Retry-After, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, ' +
  'x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset-tokens';

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
    ...extraHeaders,
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

const REACT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const API_ROUTES = [
  'GET /',
  'GET /react/',
  'GET /health',
  'POST /chat',
  'POST /query',
  'POST /chat/stream',
  'GET /usage',
];

/** Serve built Vite assets under /react/ from public/react (404 gracefully if missing). */
async function tryServeReactStatic(
  res: ServerResponse,
  publicDir: string,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/react')) return false;
  const reactRoot = path.join(publicDir, 'react');
  let rel = pathname === '/react' || pathname === '/react/' ? 'index.html' : pathname.slice('/react/'.length);
  // basic path traversal guard
  if (rel.includes('..')) {
    sendJson(res, 400, { error: 'Invalid path' });
    return true;
  }
  const filePath = path.resolve(reactRoot, rel);
  const rootResolved = path.resolve(reactRoot);
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (filePath !== rootResolved && !filePath.startsWith(rootWithSep)) {
    sendJson(res, 400, { error: 'Invalid path' });
    return true;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = REACT_MIME[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
    return true;
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: string }).code) : '';
    if (code === 'ENOENT') {
      sendJson(res, 404, {
        error: 'React client not built',
        hint: 'Run: npm run client:build  (requires client/ deps). Static UI remains at GET /',
        routes: API_ROUTES,
      });
      return true;
    }
    throw err;
  }
}


function writeSseHeaders(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
    ...extraHeaders,
  });
}

export interface GatewayDeps {
  provider: LlmProvider;
  corpus: CorpusChunk[];
  topK?: number;
  publicDir?: string;
  /** Optional per-API-key rate limit + token budget (off when undefined). */
  quotas?: KeyQuotas;
}

type QuotaGate =
  | { ok: true; key: string; reservation?: Reservation; promptTokens: number; headers: Record<string, string> }
  | { ok: false };

/**
 * Reserve quota for a chat request or answer 429/413 to the caller.
 * Reservation = estimated prompt tokens + COMPLETION_MAX_TOKENS (worst case), settled later.
 */
function gateQuota(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
  message: string,
  topK: number,
): QuotaGate {
  const key = apiKeyFrom(req.headers);
  if (!deps.quotas) return { ok: true, key, promptTokens: 0, headers: {} };
  const promptTokens = estimatePromptTokens(deps.corpus, { message, topK });
  const r = deps.quotas.reserve(key, promptTokens + COMPLETION_MAX_TOKENS);
  if (!r.ok) {
    sendJson(
      res,
      r.status,
      {
        error: r.status === 429 ? 'rate_limited' : 'request_exceeds_budget',
        reason: r.reason,
        message: r.error,
        ...(r.retryAfterMs !== undefined ? { retryAfterSec: Math.ceil(r.retryAfterMs / 1000) } : {}),
      },
      r.headers,
    );
    return { ok: false };
  }
  return { ok: true, key, reservation: r.reservation, promptTokens, headers: r.headers };
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
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
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
          routes: API_ROUTES,
          quotas: deps.quotas ? 'per-key' : 'off',
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/usage') {
        // Caller's own usage (keyed by x-api-key), never another key's.
        const key = apiKeyFrom(req.headers);
        if (!deps.quotas) {
          sendJson(res, 200, { key, enabled: false, hint: 'Set KEY_RPM / KEY_TOKENS_PER_WINDOW' });
          return;
        }
        sendJson(res, 200, { enabled: true, ...deps.quotas.usage(key) }, deps.quotas.headers(key));
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
        const topK = parsed.topK ?? topKDefault;
        const gate = gateQuota(deps, req, res, message, topK);
        if (!gate.ok) return;
        let result: Awaited<ReturnType<typeof handleChat>>;
        try {
          result = await handleChat(deps.provider, deps.corpus, { message, topK });
        } catch (err) {
          if (gate.reservation) deps.quotas?.release(gate.reservation);
          throw err;
        }
        if (gate.reservation && deps.quotas) {
          deps.quotas.settle(gate.reservation, gate.promptTokens + estimateTokens(result.answer));
          sendJson(res, 200, result, deps.quotas.headers(gate.key));
          return;
        }
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

        const topK = parsed.topK ?? topKDefault;
        const gate = gateQuota(deps, req, res, message, topK);
        if (!gate.ok) return; // 429/413 JSON before any SSE headers

        writeSseHeaders(res, gate.headers);
        // Comment frame helps some proxies flush headers immediately.
        res.write(': connected\n\n');

        let streamed = '';
        try {
          for await (const evt of handleChatStream(deps.provider, deps.corpus, { message, topK })) {
            if (evt.type === 'token') streamed += evt.text;
            res.write(
              formatSseEvent({
                event: evt.type,
                data: JSON.stringify(evt),
              }),
            );
          }
        } catch (err) {
          if (gate.reservation) deps.quotas?.release(gate.reservation);
          // Only reached before the first token (chain exhausted / fatal): nothing was
          // streamed yet, so the client can safely retry the whole request.
          const msg = err instanceof Error ? err.message : String(err);
          res.write(
            formatSseEvent({
              event: 'error',
              data: JSON.stringify({
                type: 'error',
                error: msg,
                afterFirstToken: false,
                ...(err instanceof FallbackError ? { reason: err.reason, attempts: err.attempts } : {}),
              }),
            }),
          );
        }
        // Settle with what was actually streamed (no-op if already released).
        if (gate.reservation) {
          deps.quotas?.settle(gate.reservation, gate.promptTokens + estimateTokens(streamed));
        }
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
        sendText(res, 200, html, 'text/html; charset=utf-8');
        return;
      }

      if (req.method === 'GET' && (await tryServeReactStatic(res, publicDir, url.pathname))) {
        return;
      }

      sendJson(res, 404, {
        error: 'Not found',
        routes: API_ROUTES,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent && err instanceof FallbackError) {
        // Upstream chain gave up: 502 + every attempt so learners can see the retry trail.
        sendJson(res, 502, { error: message, reason: err.reason, attempts: err.attempts });
        return;
      }
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
  const provider = createProviderFromEnv(process.env, (msg) => console.log(`[ts-ai-gateway-demo] ${msg}`));
  const corpus = await loadCorpus();

  console.log(
    `[ts-ai-gateway-demo] provider=${provider.name} corpusChunks=${corpus.length} port=${PORT}`,
  );
  console.log(
    'OSS/learning portfolio demo — NOT employer production. Offline mock is the default.',
  );

  const quotas = createQuotasFromEnv(process.env);
  if (quotas) console.log('[ts-ai-gateway-demo] per-key quotas ON (in-memory, single process)');

  const server = createGatewayServer({ provider, corpus, topK: TOP_K, quotas });
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
