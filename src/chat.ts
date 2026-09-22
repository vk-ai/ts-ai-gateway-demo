import type { LlmProvider } from './providers/index.js';
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

export interface ChatResponse {
  answer: string;
  retrieved: RetrievedChunk[];
  provider: string;
  model: string;
  metrics: {
    groundedness: number;
    retrievedCount: number;
  };
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
  };
}

async function buildChat(
  provider: LlmProvider,
  corpus: CorpusChunk[],
  request: ChatRequest,
): Promise<ChatResponse> {
  const message = request.message?.trim();
  if (!message) {
    throw new Error('message is required');
  }

  const topK = request.topK ?? 3;
  const retrieved = retrieve(message, corpus, topK);
  const contextText = retrieved.map((r) => `[${r.source}] ${r.text}`).join('\n\n');

  const result = await provider.complete({
    messages: [
      { role: 'system', content: `${SYSTEM_PREAMBLE}\n${contextText}` },
      { role: 'user', content: message },
    ],
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
  };
}

/**
 * Async generator that yields SSE-friendly chat events:
 * meta → citations → token* → done.
 * Citations-first teaches the Azure/OpenAI + rag-chat-ui pattern: sources before tokens.
 * Uses the same retrieve→complete path as /chat, then chunks the finished answer
 * (mock/OpenAI both complete first — teaching demo, not true provider token streaming).
 */
export async function* handleChatStream(
  provider: LlmProvider,
  corpus: CorpusChunk[],
  request: ChatRequest,
  opts?: { chunkSize?: number },
): AsyncGenerator<ChatStreamEvent> {
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
