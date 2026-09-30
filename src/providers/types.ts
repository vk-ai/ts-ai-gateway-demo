/**
 * Shared LLM provider contract.
 * Implementations: MockProvider (default, offline), OpenAIProvider (optional),
 * FlakyMockProvider (deterministic faults for tests) and FallbackProvider (chain).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Aborted by the fallback chain on per-attempt timeout (providers should honour it). */
  signal?: AbortSignal;
}

/** One provider call made by the fallback chain (surfaced in responses for teaching). */
export interface AttemptRecord {
  provider: string;
  /** 0-based retry index for this provider. */
  attempt: number;
  outcome: 'ok' | 'retry' | 'fallback' | 'fatal' | 'mid_stream_error';
  status?: number;
  error?: string;
  /** Backoff slept *after* this attempt before the next one (ms). */
  delayMs?: number;
  elapsedMs: number;
}

export interface ChatCompletionResult {
  content: string;
  provider: string;
  model: string;
  /** Present when served through FallbackProvider. */
  attempts?: AttemptRecord[];
  servedBy?: string;
}

export interface StreamOptions {
  /** Chunk size used when a stream is synthesized from complete(). */
  chunkSize?: number;
}

/** Returned by stream(): model info is known up front; tokens arrive lazily. */
export interface ProviderStream {
  provider: string;
  model: string;
  tokens: AsyncIterable<string>;
  /** Filled in by FallbackProvider (includes attempts that failed before first token). */
  attempts?: AttemptRecord[];
  servedBy?: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
  /** Optional true streaming. Chain code synthesizes a stream from complete() when absent. */
  stream?(request: ChatCompletionRequest, opts?: StreamOptions): Promise<ProviderStream>;
}
