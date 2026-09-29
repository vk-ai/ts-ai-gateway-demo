/**
 * Provider error taxonomy for retry / fallback decisions.
 * Teaching code — same *shape* as gateway retry policies, not LiteLLM/Portkey.
 */

export type ProviderErrorKind = 'http' | 'timeout' | 'network';

/** Error thrown by providers so the fallback chain can classify it. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  /** Parsed `Retry-After` (milliseconds), when the upstream sent one. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { provider: string; kind?: ProviderErrorKind; status?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.provider = opts.provider;
    this.kind = opts.kind ?? 'http';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * What the chain should do with an error:
 * - `retry`:    transient (429, 408, 5xx, timeout, network) → back off, retry same provider,
 *               then move to the next provider when retries run out
 * - `fallback`: provider-specific config problem (401/403/404) → don't retry, try next provider
 * - `fatal`:    the request itself is bad (400/413/422, other 4xx, unknown errors) → stop;
 *               another provider would reject it too
 */
export type ErrorAction = 'retry' | 'fallback' | 'fatal';

export function classifyError(err: unknown): ErrorAction {
  if (err instanceof ProviderError) {
    if (err.kind === 'timeout' || err.kind === 'network') return 'retry';
    const s = err.status ?? 0;
    if (s === 429 || s === 408 || s >= 500) return 'retry';
    if (s === 401 || s === 403 || s === 404) return 'fallback';
    return 'fatal';
  }
  if (err instanceof Error) {
    // fetch() network failures surface as TypeError; aborts as AbortError/TimeoutError
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'retry';
    if (err.name === 'TypeError' && /fetch failed|network/i.test(err.message)) return 'retry';
  }
  return 'fatal';
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns `undefined` for missing / unparseable values; never negative.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Build a ProviderError from a non-2xx fetch Response (reads Retry-After). */
export async function providerErrorFromResponse(provider: string, res: Response): Promise<ProviderError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return new ProviderError(`${provider} API error ${res.status}: ${body.slice(0, 300)}`, {
    provider,
    kind: 'http',
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
  });
}
