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

export type ChatStreamEvent =
  | { type: 'meta'; provider: string; model: string; retrievedCount: number }
  | { type: 'token'; text: string }
  | {
      type: 'done';
      answer: string;
      retrieved: RetrievedChunk[];
      provider: string;
      model: string;
      metrics: { groundedness: number; retrievedCount: number };
    };

const SYSTEM_PREAMBLE =
  'You are a helpful support assistant. Answer ONLY using the retrieved context below. ' +
  'If the context is insufficient, say so clearly. Do not invent policies.\n\n' +
  'Retrieved context:';

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
 * meta → token* → done. Uses the same retrieve→complete path as /chat,
 * then chunks the finished answer (mock/OpenAI both complete first — teaching demo).
 */
export async function* handleChatStream(
  provider: LlmProvider,
  corpus: CorpusChunk[],
  request: ChatRequest,
  opts?: { chunkSize?: number },
): AsyncGenerator<ChatStreamEvent> {
  const built = await buildChat(provider, corpus, request);
  yield {
    type: 'meta',
    provider: built.provider,
    model: built.model,
    retrievedCount: built.metrics.retrievedCount,
  };
  for (const text of chunkText(built.answer, opts?.chunkSize ?? 12)) {
    yield { type: 'token', text };
  }
  yield {
    type: 'done',
    answer: built.answer,
    retrieved: built.retrieved,
    provider: built.provider,
    model: built.model,
    metrics: built.metrics,
  };
}
