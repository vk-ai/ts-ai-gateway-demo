/**
 * Per-API-key request rate limit + token budget (in-memory, single process).
 *
 * The fallback chain already handles *upstream* 429s. This is the *downstream* half: the
 * gateway protects itself (and its provider bill) from any one caller.
 *
 * Two token buckets per key, both refilled continuously:
 * - requests: capacity `burst` (default = requestsPerMinute), refills requestsPerMinute / 60s
 * - tokens:   capacity `tokensPerWindow`, refills tokensPerWindow / windowMs
 *
 * Flow per call: estimate tokens → `reserve()` (checks both buckets, takes the request and
 * the token estimate atomically) → call the provider → `settle()` with the real count (unused
 * tokens are refunded; overage is charged and may go negative) or `release()` on failure.
 * Rejections carry `retryAfterMs`, computed from the bucket deficit and refill rate, plus
 * `x-ratelimit-*` headers, so callers can back off precisely.
 *
 * Teaching code with the same *shape* as gateway quotas (LiteLLM budgets, Arcjet token buckets,
 * Upstash ratelimit). It is not distributed (no Redis), not auth (keys are just identifiers),
 * and not billing-grade token counting (chars/4 estimate).
 */

export interface KeyLimits {
  /** Sustained requests per minute (token-bucket refill rate). */
  requestsPerMinute: number;
  /** Request bucket capacity (max burst). Defaults to requestsPerMinute. */
  burst?: number;
  /** Token budget that refills over `windowMs`. */
  tokensPerWindow: number;
  /** Token budget window in ms (default 60_000). */
  windowMs?: number;
}

export interface QuotaOptions {
  defaults: KeyLimits;
  /** Per-key overrides (e.g. a "free" key with a smaller budget). */
  perKey?: Record<string, Partial<KeyLimits>>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export type QuotaReason = 'requests' | 'tokens';

export interface Reservation {
  key: string;
  estimatedTokens: number;
  settled: boolean;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation; headers: Record<string, string> }
  | {
      ok: false;
      status: 429 | 413;
      reason: QuotaReason;
      error: string;
      /** Undefined for 413 (the request can never fit the budget). */
      retryAfterMs?: number;
      headers: Record<string, string>;
    };

export interface KeyUsage {
  key: string;
  limits: Required<KeyLimits>;
  requests: { total: number; rejected: number; remaining: number };
  tokens: { used: number; reserved: number; remaining: number };
}

/** Rough token estimate (≈4 chars per token for English). Not a real tokenizer. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

class TokenBucket {
  level: number;
  private last: number;

  constructor(
    readonly capacity: number,
    /** Units added per ms. */
    readonly refillPerMs: number,
    now: number,
  ) {
    this.level = capacity;
    this.last = now;
  }

  refill(now: number): void {
    const dt = Math.max(0, now - this.last);
    this.level = Math.min(this.capacity, this.level + dt * this.refillPerMs);
    this.last = now;
  }

  /** ms until `amount` is available (0 if available now). Call after refill(). */
  waitMs(amount: number): number {
    const deficit = amount - this.level;
    if (deficit <= 0) return 0;
    return this.refillPerMs > 0 ? Math.ceil(deficit / this.refillPerMs) : Number.POSITIVE_INFINITY;
  }
}

interface KeyState {
  limits: Required<KeyLimits>;
  requests: TokenBucket;
  tokens: TokenBucket;
  totalRequests: number;
  rejected: number;
  tokensUsed: number;
  reserved: number;
}

function resolveLimits(base: KeyLimits, override?: Partial<KeyLimits>): Required<KeyLimits> {
  const merged = { ...base, ...(override ?? {}) };
  const out: Required<KeyLimits> = {
    requestsPerMinute: merged.requestsPerMinute,
    burst: merged.burst ?? merged.requestsPerMinute,
    tokensPerWindow: merged.tokensPerWindow,
    windowMs: merged.windowMs ?? 60_000,
  };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`quota limit ${k} must be a positive number`);
  }
  return out;
}

export class KeyQuotas {
  private readonly keys = new Map<string, KeyState>();
  private readonly now: () => number;

  constructor(private readonly opts: QuotaOptions) {
    this.now = opts.now ?? Date.now;
    resolveLimits(opts.defaults); // validate early
  }

  private state(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      const limits = resolveLimits(this.opts.defaults, this.opts.perKey?.[key]);
      const t = this.now();
      s = {
        limits,
        requests: new TokenBucket(limits.burst, limits.requestsPerMinute / 60_000, t),
        tokens: new TokenBucket(limits.tokensPerWindow, limits.tokensPerWindow / limits.windowMs, t),
        totalRequests: 0,
        rejected: 0,
        tokensUsed: 0,
        reserved: 0,
      };
      this.keys.set(key, s);
    }
    const t = this.now();
    s.requests.refill(t);
    s.tokens.refill(t);
    return s;
  }

  private headersFor(s: KeyState): Record<string, string> {
    const tokenResetMs = s.tokens.waitMs(s.tokens.capacity);
    return {
      'x-ratelimit-limit-requests': String(s.limits.burst),
      'x-ratelimit-remaining-requests': String(Math.max(0, Math.floor(s.requests.level))),
      'x-ratelimit-limit-tokens': String(s.limits.tokensPerWindow),
      'x-ratelimit-remaining-tokens': String(Math.max(0, Math.floor(s.tokens.level))),
      'x-ratelimit-reset-tokens': `${Math.ceil(tokenResetMs / 1000)}s`,
    };
  }

  /** Check both buckets and, if both pass, take 1 request + `estimatedTokens`. */
  reserve(key: string, estimatedTokens: number): ReserveResult {
    const s = this.state(key);
    const est = Math.max(0, Math.ceil(estimatedTokens));
    if (est > s.limits.tokensPerWindow) {
      s.rejected += 1;
      return {
        ok: false,
        status: 413,
        reason: 'tokens',
        error: `estimated ${est} tokens exceeds the per-window budget of ${s.limits.tokensPerWindow}`,
        headers: this.headersFor(s),
      };
    }
    const reqWait = s.requests.waitMs(1);
    const tokWait = s.tokens.waitMs(est);
    if (reqWait > 0 || tokWait > 0) {
      s.rejected += 1;
      const reason: QuotaReason = reqWait >= tokWait ? 'requests' : 'tokens';
      const retryAfterMs = Math.max(reqWait, tokWait);
      return {
        ok: false,
        status: 429,
        reason,
        error:
          reason === 'requests'
            ? `rate limit: ${s.limits.requestsPerMinute} requests/min for this key`
            : `token budget: ${s.limits.tokensPerWindow} tokens per ${s.limits.windowMs / 1000}s for this key`,
        retryAfterMs,
        headers: { ...this.headersFor(s), 'retry-after': String(Math.ceil(retryAfterMs / 1000)) },
      };
    }
    s.requests.level -= 1;
    s.tokens.level -= est;
    s.totalRequests += 1;
    s.reserved += est;
    return {
      ok: true,
      reservation: { key, estimatedTokens: est, settled: false },
      headers: this.headersFor(s),
    };
  }

  /** Replace the estimate with the actual count (refund unused, charge overage). */
  settle(r: Reservation, actualTokens: number): void {
    if (r.settled) return;
    r.settled = true;
    const s = this.state(r.key);
    const actual = Math.max(0, Math.ceil(actualTokens));
    s.reserved -= r.estimatedTokens;
    s.tokens.level = Math.min(s.tokens.capacity, s.tokens.level + r.estimatedTokens - actual);
    s.tokensUsed += actual;
  }

  /** Provider failed: refund the token estimate (the request still counts toward RPM). */
  release(r: Reservation): void {
    this.settle(r, 0);
  }

  /** Current `x-ratelimit-*` headers for a key (e.g. after settle). */
  headers(key: string): Record<string, string> {
    return this.headersFor(this.state(key));
  }

  usage(key: string): KeyUsage {
    const s = this.state(key);
    return {
      key,
      limits: { ...s.limits },
      requests: {
        total: s.totalRequests,
        rejected: s.rejected,
        remaining: Math.max(0, Math.floor(s.requests.level)),
      },
      tokens: {
        used: s.tokensUsed,
        reserved: s.reserved,
        remaining: Math.max(0, Math.floor(s.tokens.level)),
      },
    };
  }
}

function posNum(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Build quotas from env, or `undefined` when disabled (default: off, behaviour unchanged).
 * - `KEY_RPM`, `KEY_BURST`, `KEY_TOKENS_PER_WINDOW`, `KEY_WINDOW_MS` set the defaults
 *   (quotas turn on when `KEY_RPM` or `KEY_TOKENS_PER_WINDOW` is set).
 * - `KEY_LIMITS` is optional per-key JSON, e.g. `{"free-key":{"requestsPerMinute":2}}`.
 */
export function createQuotasFromEnv(env: NodeJS.ProcessEnv = process.env): KeyQuotas | undefined {
  const rpm = posNum(env.KEY_RPM);
  const tpw = posNum(env.KEY_TOKENS_PER_WINDOW);
  if (rpm === undefined && tpw === undefined) return undefined;
  let perKey: QuotaOptions['perKey'];
  if (env.KEY_LIMITS && env.KEY_LIMITS.trim()) {
    try {
      perKey = JSON.parse(env.KEY_LIMITS) as QuotaOptions['perKey'];
    } catch {
      throw new Error('KEY_LIMITS must be JSON, e.g. {"free-key":{"requestsPerMinute":2}}');
    }
  }
  return new KeyQuotas({
    defaults: {
      requestsPerMinute: rpm ?? 60,
      burst: posNum(env.KEY_BURST),
      tokensPerWindow: tpw ?? 20_000,
      windowMs: posNum(env.KEY_WINDOW_MS),
    },
    perKey,
  });
}

/** Caller identity: `x-api-key` header (or `Authorization: Bearer …`), else "anonymous". */
export function apiKeyFrom(headers: Record<string, string | string[] | undefined>): string {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();
  const direct = pick(headers['x-api-key']);
  if (direct) return direct;
  const auth = pick(headers['authorization']);
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || 'anonymous';
}
