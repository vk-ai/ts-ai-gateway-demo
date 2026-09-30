import { FallbackProvider, type FallbackOptions } from './fallback.js';
import { FlakyMockProvider } from './flaky.js';
import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';
import type { LlmProvider } from './types.js';

export type {
  AttemptRecord,
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmProvider,
  ProviderStream,
  StreamOptions,
} from './types.js';
export { MockProvider } from './mock.js';
export { OpenAIProvider } from './openai.js';
export { FallbackError, FallbackProvider, computeBackoffMs, type FallbackOptions } from './fallback.js';
export { FlakyMockProvider, parseFaults, type FlakyFault } from './flaky.js';
export { ProviderError, classifyError, parseRetryAfter } from './errors.js';

export type ProviderKind = 'mock' | 'openai';
export type ChainProviderKind = ProviderKind | 'flaky';

export function createProvider(
  kind: ProviderKind = 'mock',
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider {
  if (kind === 'openai') {
    const key = env.OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        'LLM_PROVIDER=openai requires OPENAI_API_KEY. Use LLM_PROVIDER=mock for offline mode.',
      );
    }
    return new OpenAIProvider(key, env.OPENAI_MODEL ?? 'gpt-4o-mini', env.OPENAI_BASE_URL);
  }
  return new MockProvider();
}

export function resolveProviderKind(env: NodeJS.ProcessEnv = process.env): ProviderKind {
  const raw = (env.LLM_PROVIDER ?? 'mock').toLowerCase();
  if (raw === 'openai' && env.OPENAI_API_KEY) return 'openai';
  return 'mock';
}

function numEnv(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Build the runtime provider from env.
 * - `LLM_FALLBACKS` unset → single provider exactly as before (`LLM_PROVIDER`).
 * - `LLM_FALLBACKS=openai,mock` → FallbackProvider over that ordered chain.
 *   `openai` is skipped (with a note) when no key is set; `flaky` uses `FLAKY_FAULTS`.
 * Tuning: `LLM_MAX_RETRIES`, `LLM_TIMEOUT_MS`, `LLM_BACKOFF_BASE_MS`, `LLM_BACKOFF_MAX_MS`,
 * `LLM_MAX_RETRY_AFTER_MS`.
 */
export function createProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = () => {},
): LlmProvider {
  const chain = (env.LLM_FALLBACKS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (chain.length === 0) return createProvider(resolveProviderKind(env), env);

  const providers: LlmProvider[] = [];
  for (const kind of chain) {
    if (kind === 'mock') providers.push(new MockProvider());
    else if (kind === 'flaky') providers.push(new FlakyMockProvider(env.FLAKY_FAULTS ?? ''));
    else if (kind === 'openai') {
      if (env.OPENAI_API_KEY) providers.push(createProvider('openai', env));
      else log('LLM_FALLBACKS: skipping openai (no OPENAI_API_KEY)');
    } else throw new Error(`Unknown provider in LLM_FALLBACKS: ${kind}`);
  }
  if (providers.length === 0) providers.push(new MockProvider());

  const opts: FallbackOptions = {
    maxRetries: numEnv(env.LLM_MAX_RETRIES),
    timeoutMs: numEnv(env.LLM_TIMEOUT_MS),
    baseDelayMs: numEnv(env.LLM_BACKOFF_BASE_MS),
    maxDelayMs: numEnv(env.LLM_BACKOFF_MAX_MS),
    maxRetryAfterMs: numEnv(env.LLM_MAX_RETRY_AFTER_MS),
  };
  return new FallbackProvider(providers, opts);
}
