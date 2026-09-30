/**
 * FlakyMockProvider — deterministic fault injection for retry/fallback tests and demos.
 *
 * Each call (complete or stream) consumes the next fault from a fixed script; once the
 * script is used up every call succeeds by delegating to MockProvider. No randomness.
 *
 * Script syntax (env `FLAKY_FAULTS`, comma-separated):
 *   429        HTTP 429 (no Retry-After)      429:2   HTTP 429 with Retry-After: 2 (seconds)
 *   503 / 500  HTTP 5xx                        401 / 400  other statuses
 *   timeout    never answers until aborted     network  fetch-style network failure
 *   drop@N     stream sends N tokens then drops (complete() is unaffected)
 *   ok         succeed this call
 */

import { chunkText } from '../sse.js';
import { ProviderError } from './errors.js';
import { MockProvider } from './mock.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  LlmProvider,
  ProviderStream,
  StreamOptions,
} from './types.js';

export type FlakyFault =
  | { kind: 'ok' }
  | { kind: 'http'; status: number; retryAfterSec?: number }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'drop'; afterTokens: number };

export function parseFaults(spec: string | undefined): FlakyFault[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((tok): FlakyFault => {
      if (tok === 'ok') return { kind: 'ok' };
      if (tok === 'timeout') return { kind: 'timeout' };
      if (tok === 'network') return { kind: 'network' };
      const drop = /^drop@(\d+)$/.exec(tok);
      if (drop) return { kind: 'drop', afterTokens: Number(drop[1]) };
      const http = /^(\d{3})(?::(\d+(?:\.\d+)?))?$/.exec(tok);
      if (http) {
        return {
          kind: 'http',
          status: Number(http[1]),
          ...(http[2] !== undefined ? { retryAfterSec: Number(http[2]) } : {}),
        };
      }
      throw new Error(`Unknown FLAKY_FAULTS token: ${tok}`);
    });
}

function waitForAbort(signal: AbortSignal | undefined, provider: string): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(new ProviderError(`${provider} request aborted`, { provider, kind: 'timeout' }));
    if (signal?.aborted) return fail();
    signal?.addEventListener('abort', fail, { once: true });
    // No signal → hang forever (the chain's timeout race still wins).
  });
}

export class FlakyMockProvider implements LlmProvider {
  readonly name: string;
  private readonly script: FlakyFault[];
  private readonly inner: LlmProvider;
  /** Number of calls received (complete + stream) — handy in tests. */
  calls = 0;

  constructor(faults: FlakyFault[] | string = [], opts: { name?: string; inner?: LlmProvider } = {}) {
    this.script = typeof faults === 'string' ? parseFaults(faults) : [...faults];
    this.inner = opts.inner ?? new MockProvider();
    this.name = opts.name ?? 'flaky';
  }

  private nextFault(): FlakyFault {
    const i = this.calls;
    this.calls += 1;
    return this.script[i] ?? { kind: 'ok' };
  }

  private raise(fault: FlakyFault): void {
    if (fault.kind === 'http') {
      throw new ProviderError(`${this.name} injected HTTP ${fault.status}`, {
        provider: this.name,
        kind: 'http',
        status: fault.status,
        retryAfterMs: fault.retryAfterSec !== undefined ? fault.retryAfterSec * 1000 : undefined,
      });
    }
    if (fault.kind === 'network') {
      throw new ProviderError(`${this.name} injected network error`, { provider: this.name, kind: 'network' });
    }
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const fault = this.nextFault();
    this.raise(fault);
    if (fault.kind === 'timeout') return waitForAbort(request.signal, this.name);
    const res = await this.inner.complete(request);
    return { ...res, provider: this.name };
  }

  async stream(request: ChatCompletionRequest, opts: StreamOptions = {}): Promise<ProviderStream> {
    const fault = this.nextFault();
    this.raise(fault); // HTTP / network faults fail before the stream opens
    const name = this.name;
    if (fault.kind === 'timeout') {
      // Stream "opens" but the first token never arrives.
      return {
        provider: name,
        model: 'mock-v1',
        tokens: (async function* () {
          yield await waitForAbort(request.signal, name);
        })(),
      };
    }
    const res = await this.inner.complete(request);
    const pieces = chunkText(res.content, opts.chunkSize ?? 12);
    const dropAfter = fault.kind === 'drop' ? fault.afterTokens : Infinity;
    return {
      provider: name,
      model: res.model,
      tokens: (async function* () {
        for (let i = 0; i < pieces.length; i++) {
          if (i >= dropAfter) {
            throw new ProviderError(`${name} connection dropped after ${i} token(s)`, {
              provider: name,
              kind: 'network',
            });
          }
          yield pieces[i] as string;
        }
      })(),
    };
  }
}
