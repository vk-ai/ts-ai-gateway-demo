/**
 * FallbackProvider — ordered provider chain with retry + jittered exponential backoff.
 *
 * - Retryable errors (429, 408, 5xx, timeout, network): back off and retry the same
 *   provider up to `maxRetries` times, honouring `Retry-After`, then move on.
 * - Provider-config errors (401/403/404): skip straight to the next provider.
 * - Request errors (400/422, other 4xx): stop — another provider would reject it too.
 * - Streams: fallback is allowed only *before the first token*. Once a token has been
 *   handed to the caller, a failure surfaces as a mid-stream error; we never splice a
 *   second model's text onto the first model's partial answer.
 *
 * Teaching wrapper: not LiteLLM / Portkey / Vercel AI Gateway; no shared circuit breaker.
 */

import { chunkText } from '../sse.js';
import { classifyError, ProviderError, type ErrorAction } from './errors.js';
import type {
  AttemptRecord,
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmProvider,
  ProviderStream,
  StreamOptions,
} from './types.js';

export interface FallbackOptions {
  /** Retries per provider after the first try (default 2 → up to 3 calls each). */
  maxRetries?: number;
  /** Base backoff (ms) for attempt 0; doubles each retry (default 250). */
  baseDelayMs?: number;
  /** Cap for computed exponential backoff (default 4000). */
  maxDelayMs?: number;
  /** If upstream `Retry-After` exceeds this, don't wait — fall back now (default 10000). */
  maxRetryAfterMs?: number;
  /** Per-attempt timeout; for streams this is the time-to-first-token budget (default 15000). */
  timeoutMs?: number;
  /** Jitter source in [0, 1) — inject for deterministic tests (default Math.random). */
  random?: () => number;
  /** Sleep implementation — inject a fake in tests (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Chunk size when synthesizing a stream from complete() (default 12). */
  chunkSize?: number;
}

export type FallbackErrorReason = 'fatal' | 'exhausted' | 'mid_stream';

/** Thrown when the chain gives up. Carries every attempt for debugging / UI. */
export class FallbackError extends Error {
  readonly reason: FallbackErrorReason;
  readonly attempts: AttemptRecord[];
  readonly lastError: unknown;

  constructor(reason: FallbackErrorReason, attempts: AttemptRecord[], lastError: unknown) {
    const last = lastError instanceof Error ? lastError.message : String(lastError);
    const prefix =
      reason === 'mid_stream'
        ? 'provider failed after first token (no mid-stream fallback)'
        : reason === 'fatal'
          ? 'non-retryable provider error'
          : `all providers failed after ${attempts.length} attempt(s)`;
    super(`${prefix}: ${last}`);
    this.name = 'FallbackError';
    this.reason = reason;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Backoff before retry `attempt` (0-based). Honours `retryAfterMs` exactly when present;
 * otherwise "equal jitter": half the capped exponential delay plus a random half.
 */
export function computeBackoffMs(
  attempt: number,
  opts: { baseDelayMs: number; maxDelayMs: number; random: () => number },
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return Math.max(0, retryAfterMs);
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + opts.random() * (exp / 2));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn` with an AbortSignal that fires after `ms`; rejects with a timeout ProviderError. */
async function withTimeout<T>(
  provider: string,
  ms: number,
  parent: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parent?.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ProviderError(`${provider} timed out after ${ms}ms`, { provider, kind: 'timeout' });
      ctrl.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}

function describe(err: unknown): { status?: number; error: string } {
  if (err instanceof ProviderError) return { status: err.status, error: err.message };
  return { error: err instanceof Error ? err.message : String(err) };
}

/** Synthesize a stream from complete() for providers without native streaming. */
async function streamOf(provider: LlmProvider, req: ChatCompletionRequest, opts: StreamOptions): Promise<ProviderStream> {
  if (provider.stream) return provider.stream(req, opts);
  const res = await provider.complete(req);
  const pieces = chunkText(res.content, opts.chunkSize ?? 12);
  return {
    provider: res.provider,
    model: res.model,
    tokens: (async function* () {
      yield* pieces;
    })(),
  };
}

export class FallbackProvider implements LlmProvider {
  readonly name: string;
  readonly providers: readonly LlmProvider[];
  private readonly opts: Required<FallbackOptions>;

  constructor(providers: LlmProvider[], options: FallbackOptions = {}) {
    if (providers.length === 0) throw new Error('FallbackProvider needs at least one provider');
    this.providers = providers;
    this.name = `fallback(${providers.map((p) => p.name).join('>')})`;
    this.opts = {
      maxRetries: options.maxRetries ?? 2,
      baseDelayMs: options.baseDelayMs ?? 250,
      maxDelayMs: options.maxDelayMs ?? 4000,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 10_000,
      timeoutMs: options.timeoutMs ?? 15_000,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? defaultSleep,
      chunkSize: options.chunkSize ?? 12,
    };
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.run(request, async (p, req) => p.complete(req), (res, p, attempts) => ({
      ...res,
      servedBy: p.name,
      attempts,
    }));
  }

  async stream(request: ChatCompletionRequest, opts: StreamOptions = {}): Promise<ProviderStream> {
    const streamOpts = { chunkSize: opts.chunkSize ?? this.opts.chunkSize };
    // Each attempt = open the stream AND receive the first token, under the timeout.
    // Only after that do we commit to this provider.
    return this.run(
      request,
      async (p, req) => {
        const s = await streamOf(p, req, streamOpts);
        const it = s.tokens[Symbol.asyncIterator]();
        const first = await it.next();
        return { s, it, first };
      },
      ({ s, it, first }, p, attempts) => {
        const tokens = (async function* () {
          if (first.done) return;
          yield first.value;
          try {
            for (;;) {
              const next = await it.next();
              if (next.done) return;
              yield next.value;
            }
          } catch (err) {
            // Past the first token: surface, never splice another provider's text.
            attempts.push({
              provider: p.name,
              attempt: attempts.filter((a) => a.provider === p.name).length,
              outcome: 'mid_stream_error',
              ...describe(err),
              elapsedMs: 0,
            });
            throw new FallbackError('mid_stream', attempts, err);
          }
        })();
        return { provider: s.provider, model: s.model, tokens, attempts, servedBy: p.name };
      },
    );
  }

  /** Shared retry/fallback loop for complete() and stream(). */
  private async run<T, R>(
    request: ChatCompletionRequest,
    call: (p: LlmProvider, req: ChatCompletionRequest) => Promise<T>,
    onSuccess: (value: T, p: LlmProvider, attempts: AttemptRecord[]) => R,
  ): Promise<R> {
    const attempts: AttemptRecord[] = [];
    let lastError: unknown = new Error('no providers tried');

    for (const p of this.providers) {
      for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
        if (request.signal?.aborted) {
          throw new FallbackError('fatal', attempts, new Error('request aborted by caller'));
        }
        const started = Date.now();
        try {
          const value = await withTimeout(p.name, this.opts.timeoutMs, request.signal, (signal) =>
            call(p, { ...request, signal }),
          );
          attempts.push({ provider: p.name, attempt, outcome: 'ok', elapsedMs: Date.now() - started });
          return onSuccess(value, p, attempts);
        } catch (err) {
          lastError = err;
          const action: ErrorAction = classifyError(err);
          const rec: AttemptRecord = {
            provider: p.name,
            attempt,
            outcome: action,
            ...describe(err),
            elapsedMs: Date.now() - started,
          };
          attempts.push(rec);

          if (action === 'fatal') throw new FallbackError('fatal', attempts, err);
          if (action === 'fallback') break;

          const retryAfterMs = err instanceof ProviderError ? err.retryAfterMs : undefined;
          if (retryAfterMs !== undefined && retryAfterMs > this.opts.maxRetryAfterMs) {
            rec.outcome = 'fallback'; // upstream wants us to wait too long — try the next provider
            break;
          }
          if (attempt === this.opts.maxRetries) {
            rec.outcome = 'fallback';
            break;
          }
          const delay = computeBackoffMs(attempt, this.opts, retryAfterMs);
          rec.delayMs = delay;
          await this.opts.sleep(delay);
        }
      }
    }
    throw new FallbackError('exhausted', attempts, lastError);
  }
}
