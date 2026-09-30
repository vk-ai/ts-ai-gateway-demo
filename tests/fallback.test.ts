import { describe, expect, it } from 'vitest';
import { handleChat, handleChatStream, type ChatStreamEvent } from '../src/chat.js';
import { createGatewayServer } from '../src/index.js';
import {
  classifyError,
  computeBackoffMs,
  createProviderFromEnv,
  FallbackError,
  FallbackProvider,
  FlakyMockProvider,
  MockProvider,
  parseFaults,
  parseRetryAfter,
  ProviderError,
  type ChatCompletionRequest,
  type LlmProvider,
} from '../src/providers/index.js';
import { loadCorpus } from '../src/rag/corpus.js';

const REQ: ChatCompletionRequest = {
  messages: [
    { role: 'system', content: 'Retrieved context:\nStandard ground shipping takes 3–5 business days.' },
    { role: 'user', content: 'How long is ground shipping?' },
  ],
};

/** Deterministic chain: no real sleeping, jitter pinned to 1.0 (full exponential delay). */
function chain(providers: LlmProvider[], extra: ConstructorParameters<typeof FallbackProvider>[1] = {}) {
  const sleeps: number[] = [];
  const fp = new FallbackProvider(providers, {
    baseDelayMs: 100,
    maxDelayMs: 1000,
    timeoutMs: 50,
    random: () => 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { fp, sleeps };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of stream) out.push(t);
  return out;
}

describe('error helpers', () => {
  it('parseRetryAfter handles delta-seconds, HTTP-date and junk', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it('classifyError: 429/5xx/timeout retry, 401 fallback, 400 fatal', () => {
    const e = (status: number) => new ProviderError('x', { provider: 'p', status });
    expect(classifyError(e(429))).toBe('retry');
    expect(classifyError(e(503))).toBe('retry');
    expect(classifyError(e(408))).toBe('retry');
    expect(classifyError(new ProviderError('t', { provider: 'p', kind: 'timeout' }))).toBe('retry');
    expect(classifyError(e(401))).toBe('fallback');
    expect(classifyError(e(400))).toBe('fatal');
    expect(classifyError(new Error('boom'))).toBe('fatal');
  });

  it('computeBackoffMs doubles, caps, jitters, and honours Retry-After', () => {
    const o = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 1 };
    expect([0, 1, 2, 3, 4].map((a) => computeBackoffMs(a, o))).toEqual([100, 200, 400, 800, 1000]);
    expect(computeBackoffMs(2, { ...o, random: () => 0 })).toBe(200); // equal jitter floor = exp/2
    expect(computeBackoffMs(0, o, 2500)).toBe(2500);
  });

  it('parseFaults reads the FLAKY_FAULTS script', () => {
    expect(parseFaults('429:2, 503,timeout,drop@3,ok')).toEqual([
      { kind: 'http', status: 429, retryAfterSec: 2 },
      { kind: 'http', status: 503 },
      { kind: 'timeout' },
      { kind: 'drop', afterTokens: 3 },
      { kind: 'ok' },
    ]);
    expect(() => parseFaults('teapot')).toThrow(/Unknown/);
  });
});

describe('FallbackProvider.complete', () => {
  it('retries a 429 honouring Retry-After, then succeeds on the same provider', async () => {
    const flaky = new FlakyMockProvider('429:2,503');
    const { fp, sleeps } = chain([flaky, new MockProvider()]);
    const res = await fp.complete(REQ);
    expect(res.servedBy).toBe('flaky');
    expect(flaky.calls).toBe(3);
    expect(sleeps).toEqual([2000, 200]); // Retry-After wins; then exponential (attempt 1)
    expect(res.attempts?.map((a) => a.outcome)).toEqual(['retry', 'retry', 'ok']);
    expect(res.attempts?.[0]?.status).toBe(429);
  });

  it('falls back to the next provider after retries are exhausted (5xx)', async () => {
    const flaky = new FlakyMockProvider('503,503,503');
    const { fp, sleeps } = chain([flaky, new MockProvider()]);
    const res = await fp.complete(REQ);
    expect(res.servedBy).toBe('mock');
    expect(res.provider).toBe('mock');
    expect(flaky.calls).toBe(3); // 1 try + maxRetries(2)
    expect(sleeps).toEqual([100, 200]);
    expect(res.attempts?.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
      'flaky:retry',
      'flaky:retry',
      'flaky:fallback',
      'mock:ok',
    ]);
  });

  it('treats a hung provider as a timeout (retryable) and falls back', async () => {
    const flaky = new FlakyMockProvider('timeout,timeout');
    const { fp } = chain([flaky, new MockProvider()], { maxRetries: 1, timeoutMs: 20 });
    const res = await fp.complete(REQ);
    expect(res.servedBy).toBe('mock');
    expect(res.attempts?.slice(0, 2).every((a) => /timed out|aborted/.test(a.error ?? ''))).toBe(true);
  });

  it('skips retries when Retry-After exceeds the cap and falls back immediately', async () => {
    const flaky = new FlakyMockProvider('429:60');
    const { fp, sleeps } = chain([flaky, new MockProvider()], { maxRetryAfterMs: 5000 });
    const res = await fp.complete(REQ);
    expect(res.servedBy).toBe('mock');
    expect(flaky.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('401 is not retried but falls back to the next provider', async () => {
    const flaky = new FlakyMockProvider('401');
    const { fp, sleeps } = chain([flaky, new MockProvider()]);
    const res = await fp.complete(REQ);
    expect(res.servedBy).toBe('mock');
    expect(flaky.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('400 is fatal: no retry, no fallback', async () => {
    const flaky = new FlakyMockProvider('400');
    const second = new FlakyMockProvider('', { name: 'second' });
    const { fp } = chain([flaky, second]);
    const err = await fp.complete(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FallbackError);
    expect((err as FallbackError).reason).toBe('fatal');
    expect(flaky.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  it('throws FallbackError(exhausted) with every attempt when the whole chain fails', async () => {
    const a = new FlakyMockProvider('503,503', { name: 'a' });
    const b = new FlakyMockProvider('429,429', { name: 'b' });
    const { fp } = chain([a, b], { maxRetries: 1 });
    const err = (await fp.complete(REQ).catch((e: unknown) => e)) as FallbackError;
    expect(err.reason).toBe('exhausted');
    expect(err.attempts.map((x) => `${x.provider}:${x.status}`)).toEqual(['a:503', 'a:503', 'b:429', 'b:429']);
  });
});

describe('FallbackProvider.stream (fallback only before first token)', () => {
  it('falls back when the first provider fails before the first token', async () => {
    const flaky = new FlakyMockProvider('503,timeout');
    const { fp } = chain([flaky, new MockProvider()], { maxRetries: 1, timeoutMs: 20 });
    const s = await fp.stream(REQ, { chunkSize: 8 });
    expect(s.servedBy).toBe('mock');
    const tokens = await collect(s.tokens);
    const expected = (await new MockProvider().complete(REQ)).content;
    expect(tokens.join('')).toBe(expected);
    expect(s.attempts?.map((a) => a.outcome)).toEqual(['retry', 'fallback', 'ok']);
  });

  it('never falls back after the first token: surfaces a mid-stream error instead', async () => {
    const flaky = new FlakyMockProvider('drop@2');
    const backup = new FlakyMockProvider('', { name: 'backup' });
    const { fp } = chain([flaky, backup]);
    const s = await fp.stream(REQ, { chunkSize: 8 });
    expect(s.servedBy).toBe('flaky');
    const seen: string[] = [];
    const err = await (async () => {
      for await (const t of s.tokens) seen.push(t);
    })().catch((e: unknown) => e);
    expect(seen).toHaveLength(2);
    expect(err).toBeInstanceOf(FallbackError);
    expect((err as FallbackError).reason).toBe('mid_stream');
    expect(backup.calls).toBe(0); // the backup was never asked to "continue" the answer
  });
});

describe('gateway wiring', () => {
  it('handleChat exposes routing.servedBy + attempts', async () => {
    const corpus = await loadCorpus();
    const { fp } = chain([new FlakyMockProvider('429'), new MockProvider()]);
    const res = await handleChat(fp, corpus, { message: 'How long does standard ground shipping take?' });
    expect(res.routing?.servedBy).toBe('flaky');
    expect(res.routing?.attempts.map((a) => a.outcome)).toEqual(['retry', 'ok']);
  });

  it('handleChatStream: meta names the provider that actually served the stream', async () => {
    const corpus = await loadCorpus();
    const { fp } = chain([new FlakyMockProvider('503,503,503'), new MockProvider()]);
    const events: ChatStreamEvent[] = [];
    for await (const e of handleChatStream(fp, corpus, { message: 'What is the return window?' })) events.push(e);
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(['meta', 'citations']);
    const meta = events[0];
    if (meta?.type !== 'meta') throw new Error('expected meta');
    expect(meta.provider).toBe('mock');
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.routing?.servedBy).toBe('mock');
    expect(done.answer).toBe(events.map((e) => (e.type === 'token' ? e.text : '')).join(''));
  });

  it('POST /chat/stream emits an error frame (afterFirstToken) after a mid-stream drop', async () => {
    const corpus = await loadCorpus();
    const { fp } = chain([new FlakyMockProvider('drop@1'), new MockProvider()]);
    const server = createGatewayServer({ provider: fp, corpus, topK: 3 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What is the return window?' }),
      });
      const text = await res.text();
      expect(text.match(/event: token\n/g)).toHaveLength(1);
      expect(text).toContain('event: error\n');
      expect(text).toMatch(/"afterFirstToken":true/);
      expect(text).not.toContain('event: done\n');
      expect(text.indexOf('event: token\n')).toBeLessThan(text.indexOf('event: error\n'));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('POST /chat returns 502 with the attempt trail when the chain is exhausted', async () => {
    const corpus = await loadCorpus();
    const { fp } = chain([new FlakyMockProvider('503,503,503')]);
    const server = createGatewayServer({ provider: fp, corpus, topK: 3 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What is the return window?' }),
      });
      expect(res.status).toBe(502);
      const json = (await res.json()) as { reason: string; attempts: unknown[] };
      expect(json.reason).toBe('exhausted');
      expect(json.attempts).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  it('createProviderFromEnv: LLM_FALLBACKS builds a chain; unset keeps the single mock', () => {
    expect(createProviderFromEnv({}).name).toBe('mock');
    const notes: string[] = [];
    const p = createProviderFromEnv({ LLM_FALLBACKS: 'openai,flaky,mock', FLAKY_FAULTS: '429' }, (m) => notes.push(m));
    expect(p).toBeInstanceOf(FallbackProvider);
    expect(p.name).toBe('fallback(flaky>mock)');
    expect(notes[0]).toMatch(/skipping openai/);
    expect(() => createProviderFromEnv({ LLM_FALLBACKS: 'bogus' })).toThrow(/Unknown provider/);
  });
});
