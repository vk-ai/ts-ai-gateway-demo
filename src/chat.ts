import type { AttemptRecord, ChatMessage, LlmProvider } from './providers/index.js';
import type { CorpusChunk } from './rag/corpus.js';
import {
  groundednessScore,
  retrieve,
  type RetrievedChunk,
} from './rag/retrieve.js';
import { chunkText } from './sse.js';

export interface ChatRequest {
  message: string;
  topK?: number;
}

/** Which provider in a fallback chain answered, and every attempt made (teaching aid). */
export interface RoutingInfo {
  servedBy: string;
  attempts: AttemptRecord[];
}

export interface ChatResponse {
  answer: string;
  retrieved: RetrievedChunk[];
  provider: string;
  model: string;
  metrics: {
    groundedness: number;
    retrievedCount: number;
  };
  /** Present only when the provider is a FallbackProvider chain. */
  routing?: RoutingInfo;
}

/** Citation card payload for early SSE / UI (chunk id + source + snippet). */
export interface CitationCard {
  index: number;
  id: string;
  source: string;
  text: string;
  score: number;
}

export type ChatStreamEvent =
  | { type: 'meta'; provider: string; model: string; retrievedCount: number }
  | { type: 'citations'; citations: CitationCard[] }
  | { type: 'token'; text: string }
  | {
      type: 'done';
      answer: string;
      retrieved: RetrievedChunk[];
      citations: CitationCard[];
      provider: string;
      model: string;
      metrics: { groundedness: number; retrievedCount: number };
      routing?: RoutingInfo;
    }
  | {
      /** Provider failed after tokens were sent — no fallback (would splice two models). */
      type: 'error';
      error: string;
      afterFirstToken: boolean;
      partialAnswer?: string;
      routing?: RoutingInfo;
    };

const SYSTEM_PREAMBLE =
  'You are a helpful support assistant. Answer ONLY using the retrieved context below. ' +
  'If the context is insufficient, say so clearly. Do not invent policies.\n\n' +
  'Retrieved context:';

/** Build citation cards from retrieved chunks (1-based index for UI labels). */
export function toCitationCards(retrieved: RetrievedChunk[]): CitationCard[] {
  return retrieved.map((r, i) => ({
    index: i + 1,
    id: r.id,
    source: r.source,
    text: r.text,
    score: r.score,
  }));
}

export async function handleChat(
  provider: LlmProvider,
  corpus: CorpusChunk[],
  request: ChatRequest,
): Promise<ChatResponse> {
  const built = await buildChat(provider, corpus, request);
  return {
    answer: built.answer,
    retrieved: built.retrieved,
    provider: built.provider,
    model: built.model,
    metrics: built.metrics,
    ...(built.routing ? { routing: built.routing } : {}),
  };
}

interface PreparedChat {
  retrieved: RetrievedChunk[];
  contextText: string;
  messages: ChatMessage[];
}

function prepareChat(corpus: CorpusChunk[], request: ChatRequest): PreparedChat {
  const message = request.message?.trim();
  if (!message) {
    throw new Error('message is required');
  }

  const topK = request.topK ?? 3;
  const retrieved = retrieve(message, corpus, topK);
  const contextText = retrieved.map((r) => `[${r.source}] ${r.text}`).join('\n\n');
  return {
    retrieved,
    contextText,
    messages: [
      { role: 'system', content: `${SYSTEM_PREAMBLE}\n${contextText}` },
      { role: 'user', content: message },
    ],
  };
}

async function buildChat(
  provider: LlmProvider,
  corpus: CorpusChunk[],
  request: ChatRequest,
): Promise<ChatResponse> {
  const { retrieved, contextText, messages } = prepareChat(corpus, request);

  const result = await provider.complete({
    messages,
    temperature: 0.2,
    maxTokens: 512,
  });

  const groundedness = groundednessScore(result.content, contextText);

  return {
    answer: result.content,
    retrieved,
    provider: result.provider,
    model: result.model,
    metrics: {
      groundedness,
      retrievedCount: retrieved.length,
    },
    ...(result.attempts && result.servedBy
      ? { routing: { servedBy: result.servedBy, attempts: result.attempts } }
      : {}),
  };
}

/**
 * Async generator that yields SSE-friendly chat events:
 * meta → citations → token* → done.
 * Citations-first teaches the Azure/OpenAI + rag-chat-ui pattern: sources before tokens.
 * Uses the same retrieve→complete path as /chat, then chunks the finished answer
 * (mock/OpenAI both complete first — teaching demo, not true provider token streaming).
 *
 * Providers that implement `stream()` (FallbackProvider, FlakyMockProvider) take the
 * streaming path: meta/citations are emitted only once the first token has arrived, so
 * `meta.provider` names the provider that actually served the stream. A failure after the
 * first token yields an `error` event (afterFirstToken: true) — never a silent fallback.
 */
export async function* handleChatStream(
  provider: LlmProvider,
  corpus: CorpusChunk[],
  request: ChatRequest,
  opts?: { chunkSize?: number },
): AsyncGenerator<ChatStreamEvent> {
  if (provider.stream) {
    yield* streamViaProvider(provider, corpus, request, opts);
    return;
  }
  const built = await buildChat(provider, corpus, request);
  const citations = toCitationCards(built.retrieved);
  yield {
    type: 'meta',
    provider: built.provider,
    model: built.model,
    retrievedCount: built.metrics.retrievedCount,
  };
  // Early citations event — UI can render source cards before token deltas arrive.
  yield { type: 'citations', citations };
  for (const text of chunkText(built.answer, opts?.chunkSize ?? 12)) {
    yield { type: 'token', text };
  }
  yield {
    type: 'done',
    answer: built.answer,
    retrieved: built.retrieved,
    citations,
    provider: built.provider,
    model: built.model,
    metrics: built.metrics,
  };
}

async function* streamViaProvider(
  provider: LlmProvider,
  corpus: CorpusChunk[],
  request: ChatRequest,
  opts?: { chunkSize?: number },
): AsyncGenerator<ChatStreamEvent> {
  const { retrieved, contextText, messages } = prepareChat(corpus, request);
  // Errors here (before any token) propagate to the HTTP layer as an SSE `error` frame.
  const s = await provider.stream!(
    { messages, temperature: 0.2, maxTokens: 512 },
    { chunkSize: opts?.chunkSize ?? 12 },
  );
  const routing = (): RoutingInfo | undefined =>
    s.attempts && s.servedBy ? { servedBy: s.servedBy, attempts: s.attempts } : undefined;
  const citations = toCitationCards(retrieved);
  const metricsBase = { retrievedCount: retrieved.length };

  const it = s.tokens[Symbol.asyncIterator]();
  let answer = '';
  // FallbackProvider has already pre-read the first token. For a bare streaming provider a
  // failure here still happens before any token reached the client, so it just propagates.
  const first = await it.next();
  yield { type: 'meta', provider: s.provider, model: s.model, retrievedCount: retrieved.length };
  yield { type: 'citations', citations };
  if (!first.done) {
    answer += first.value;
    yield { type: 'token', text: first.value };
    try {
      for (;;) {
        const next = await it.next();
        if (next.done) break;
        answer += next.value;
        yield { type: 'token', text: next.value };
      }
    } catch (err) {
      const r = routing();
      yield {
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
        afterFirstToken: true,
        partialAnswer: answer,
        ...(r ? { routing: r } : {}),
      };
      return;
    }
  }
  const r = routing();
  yield {
    type: 'done',
    answer,
    retrieved,
    citations,
    provider: s.provider,
    model: s.model,
    metrics: { groundedness: groundednessScore(answer, contextText), ...metricsBase },
    ...(r ? { routing: r } : {}),
  };
}
