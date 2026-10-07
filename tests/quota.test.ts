import { describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createGatewayServer } from '../src/index.js';
import { FlakyMockProvider, MockProvider, type LlmProvider } from '../src/providers/index.js';
import { loadCorpus } from '../src/rag/corpus.js';
import {
  apiKeyFrom,
  createQuotasFromEnv,
  estimateTokens,
  KeyQuotas,
  type QuotaOptions,
} from '../src/quota.js';

/** Fake clock: tests move time explicitly (no sleeping). */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function quotas(defaults: QuotaOptions['defaults'], extra: Partial<QuotaOptions> = {}) {
  const c = clock();
  return { q: new KeyQuotas({ defaults, now: c.now, ...extra }), c };
}

describe('estimateTokens', () => {
  it('uses ~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('KeyQuotas: request rate limit', () => {
  it('allows a burst, then 429s with Retry-After from the refill rate', () => {
    const { q, c } = quotas({ requestsPerMinute: 2, tokensPerWindow: 10_000 });
    expect(q.reserve('k', 10).ok).toBe(true);
    expect(q.reserve('k', 10).ok).toBe(true);
    const r = q.reserve('k', 10);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(429);
    expect(r.reason).toBe('requests');
    expect(r.retryAfterMs).toBe(30_000); // 2/min → one request every 30s
    expect(r.headers['retry-after']).toBe('30');
    expect(r.headers['x-ratelimit-remaining-requests']).toBe('0');
    c.advance(29_999);
    expect(q.reserve('k', 10).ok).toBe(false);
    c.advance(1);
    expect(q.reserve('k', 10).ok).toBe(true);
  });

  it('keys are isolated', () => {
    const { q } = quotas({ requestsPerMinute: 1, tokensPerWindow: 10_000 });
    expect(q.reserve('a', 1).ok).toBe(true);
    expect(q.reserve('a', 1).ok).toBe(false);
    expect(q.reserve('b', 1).ok).toBe(true);
  });

  it('burst can differ from the sustained rate', () => {
    const { q } = quotas({ requestsPerMinute: 60, burst: 3, tokensPerWindow: 10_000 });
    expect([1, 2, 3, 4].map(() => q.reserve('k', 1).ok)).toEqual([true, true, true, false]);
  });
});

describe('KeyQuotas: token budget', () => {
  it('reserves the estimate, settles to actual, and refunds the difference', () => {
    const { q } = quotas({ requestsPerMinute: 100, tokensPerWindow: 1000 });
    const r = q.reserve('k', 600);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(q.usage('k').tokens).toEqual({ used: 0, reserved: 600, remaining: 400 });
    // a second 600-token request does not fit while the first is in flight
    const blocked = q.reserve('k', 600);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('tokens');
    q.settle(r.reservation, 150);
    expect(q.usage('k').tokens).toEqual({ used: 150, reserved: 0, remaining: 850 });
    expect(q.reserve('k', 600).ok).toBe(true);
  });

  it('Retry-After for tokens comes from the deficit and the refill rate', () => {
    const { q, c } = quotas({ requestsPerMinute: 100, tokensPerWindow: 600, windowMs: 60_000 });
    const r = q.reserve('k', 600);
    if (!r.ok) throw new Error('expected ok');
    q.settle(r.reservation, 600);
    const blocked = q.reserve('k', 300);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.status).toBe(429);
    expect(blocked.reason).toBe('tokens');
    expect(blocked.retryAfterMs).toBe(30_000); // 300 tokens at 10 tokens/s
    c.advance(30_000);
    expect(q.reserve('k', 300).ok).toBe(true);
  });

  it('settle charges overage and is idempotent; release refunds everything', () => {
    const { q } = quotas({ requestsPerMinute: 100, tokensPerWindow: 1000 });
    const a = q.reserve('k', 100);
    if (!a.ok) throw new Error('expected ok');
    q.settle(a.reservation, 300);
    q.settle(a.reservation, 999); // ignored
    expect(q.usage('k').tokens.remaining).toBe(700);
    const b = q.reserve('k', 500);
    if (!b.ok) throw new Error('expected ok');
    q.release(b.reservation);
    expect(q.usage('k').tokens).toEqual({ used: 300, reserved: 0, remaining: 700 });
    expect(q.usage('k').requests.total).toBe(2); // released requests still count toward RPM
  });

  it('an estimate larger than the whole budget is 413 (retrying cannot help)', () => {
    const { q } = quotas({ requestsPerMinute: 100, tokensPerWindow: 500 });
    const r = q.reserve('k', 501);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(413);
    expect(r.retryAfterMs).toBeUndefined();
    expect(r.headers['retry-after']).toBeUndefined();
    expect(q.usage('k').requests.rejected).toBe(1);
  });

  it('rejections do not consume either bucket', () => {
    const { q } = quotas({ requestsPerMinute: 100, tokensPerWindow: 100 });
    expect(q.reserve('k', 80).ok).toBe(true);
    expect(q.reserve('k', 80).ok).toBe(false);
    const u = q.usage('k');
    expect(u.requests.total).toBe(1);
    expect(u.requests.remaining).toBe(99);
    expect(u.tokens.remaining).toBe(20);
  });

  it('per-key overrides', () => {
    const { q } = quotas(
      { requestsPerMinute: 100, tokensPerWindow: 10_000 },
      { perKey: { free: { requestsPerMinute: 1 } } },
    );
    expect(q.reserve('free', 1).ok).toBe(true);
    expect(q.reserve('free', 1).ok).toBe(false);
    expect(q.usage('free').limits.tokensPerWindow).toBe(10_000);
    expect(q.reserve('paid', 1).ok).toBe(true);
    expect(q.reserve('paid', 1).ok).toBe(true);
  });

  it('rejects invalid limits', () => {
    expect(() => new KeyQuotas({ defaults: { requestsPerMinute: 0, tokensPerWindow: 1 } })).toThrow();
  });
});

describe('env + key helpers', () => {
  it('createQuotasFromEnv is off by default and reads KEY_* vars', () => {
    expect(createQuotasFromEnv({})).toBeUndefined();
    const q = createQuotasFromEnv({
      KEY_RPM: '5',
      KEY_TOKENS_PER_WINDOW: '2000',
      KEY_LIMITS: '{"free":{"requestsPerMinute":1}}',
    });
    expect(q?.usage('x').limits).toMatchObject({ requestsPerMinute: 5, burst: 5, tokensPerWindow: 2000, windowMs: 60_000 });
    expect(q?.usage('free').limits.requestsPerMinute).toBe(1);
    expect(() => createQuotasFromEnv({ KEY_RPM: '5', KEY_LIMITS: 'nope' })).toThrow(/KEY_LIMITS/);
  });

  it('apiKeyFrom reads x-api-key, then Bearer, else anonymous', () => {
    expect(apiKeyFrom({ 'x-api-key': ' k1 ' })).toBe('k1');
    expect(apiKeyFrom({ authorization: 'Bearer k2' })).toBe('k2');
    expect(apiKeyFrom({ authorization: 'Basic zzz' })).toBe('anonymous');
    expect(apiKeyFrom({})).toBe('anonymous');
  });
});

// ---------------------------------------------------------------------------
// HTTP: 429 + Retry-After reach the caller
// ---------------------------------------------------------------------------

async function withServer(
  opts: { provider?: LlmProvider; quotas?: KeyQuotas },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const corpus = await loadCorpus();
  const server: Server = createGatewayServer({
    provider: opts.provider ?? new MockProvider(),
    corpus,
    topK: 3,
    quotas: opts.quotas,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

const chat = (base: string, key: string | undefined, path = '/chat') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
    body: JSON.stringify({ message: 'What is the return window?' }),
  });

describe('gateway HTTP quotas', () => {
  it('no quotas configured → behaviour unchanged, no rate-limit headers', async () => {
    await withServer({}, async (base) => {
      const res = await chat(base, 'k');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ratelimit-remaining-requests')).toBeNull();
      const usage = await (await fetch(`${base}/usage`)).json();
      expect(usage.enabled).toBe(false);
    });
  });

  it('POST /chat returns 429 + Retry-After + x-ratelimit-* once the key is over its RPM', async () => {
    const c = clock();
    const q = new KeyQuotas({ defaults: { requestsPerMinute: 2, tokensPerWindow: 100_000 }, now: c.now });
    await withServer({ quotas: q }, async (base) => {
      const ok1 = await chat(base, 'alice');
      expect(ok1.status).toBe(200);
      expect(ok1.headers.get('x-ratelimit-limit-requests')).toBe('2');
      expect(ok1.headers.get('x-ratelimit-remaining-requests')).toBe('1');
      expect((await chat(base, 'alice')).status).toBe(200);
      const limited = await chat(base, 'alice');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('30');
      expect(limited.headers.get('access-control-expose-headers')).toMatch(/Retry-After/);
      const body = await limited.json();
      expect(body).toMatchObject({ error: 'rate_limited', reason: 'requests', retryAfterSec: 30 });
      // another key is unaffected
      expect((await chat(base, 'bob')).status).toBe(200);
      c.advance(30_000);
      expect((await chat(base, 'alice')).status).toBe(200);
    });
  });

  it('token budget: usage is settled to the actual answer size and visible on GET /usage', async () => {
    const c = clock();
    const q = new KeyQuotas({ defaults: { requestsPerMinute: 100, tokensPerWindow: 5_000 }, now: c.now });
    await withServer({ quotas: q }, async (base) => {
      const res = await chat(base, 'carol');
      expect(res.status).toBe(200);
      const usage = await (await fetch(`${base}/usage`, { headers: { 'x-api-key': 'carol' } })).json();
      expect(usage.enabled).toBe(true);
      expect(usage.key).toBe('carol');
      expect(usage.tokens.reserved).toBe(0);
      expect(usage.tokens.used).toBeGreaterThan(0);
      expect(usage.tokens.used).toBeLessThan(512 + 1000); // settled below the worst-case reservation
      expect(usage.tokens.remaining).toBe(5_000 - usage.tokens.used);
    });
  });

  it('budget smaller than one worst-case request → 413, no Retry-After', async () => {
    const q = new KeyQuotas({ defaults: { requestsPerMinute: 100, tokensPerWindow: 300 } });
    await withServer({ quotas: q }, async (base) => {
      const res = await chat(base, 'dave');
      expect(res.status).toBe(413);
      expect(res.headers.get('retry-after')).toBeNull();
      expect((await res.json()).error).toBe('request_exceeds_budget');
    });
  });

  it('POST /chat/stream answers 429 JSON before any SSE frame', async () => {
    const c = clock();
    const q = new KeyQuotas({ defaults: { requestsPerMinute: 1, tokensPerWindow: 100_000 }, now: c.now });
    await withServer({ quotas: q }, async (base) => {
      const first = await chat(base, 'erin', '/chat/stream');
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(first.headers.get('x-ratelimit-remaining-requests')).toBe('0');
      expect(await first.text()).toContain('event: done');
      const second = await chat(base, 'erin', '/chat/stream');
      expect(second.status).toBe(429);
      expect(second.headers.get('content-type')).toMatch(/application\/json/);
      expect(second.headers.get('retry-after')).toBe('60');
      expect(q.usage('erin').tokens.reserved).toBe(0); // first stream was settled
    });
  });

  it('provider failure releases the token reservation', async () => {
    const q = new KeyQuotas({ defaults: { requestsPerMinute: 100, tokensPerWindow: 10_000 } });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withServer({ provider: new FlakyMockProvider('400'), quotas: q }, async (base) => {
      const res = await chat(base, 'frank');
      expect(res.status).toBeGreaterThanOrEqual(500);
      const u = q.usage('frank');
      expect(u.tokens).toEqual({ used: 0, reserved: 0, remaining: 10_000 });
      expect(u.requests.total).toBe(1);
    });
    quiet.mockRestore();
  });
});
