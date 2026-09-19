import { describe, expect, it } from 'vitest';
import { handleChatStream } from '../src/chat.js';
import { createGatewayServer } from '../src/index.js';
import { MockProvider } from '../src/providers/mock.js';
import { loadCorpus } from '../src/rag/corpus.js';
import { chunkText, formatSseEvent } from '../src/sse.js';

describe('SSE framing helpers', () => {
  it('formatSseEvent emits data lines and blank terminator', () => {
    const frame = formatSseEvent({ event: 'token', data: JSON.stringify({ type: 'token', text: 'hi' }) });
    expect(frame).toContain('event: token\n');
    expect(frame).toContain('data: {"type":"token","text":"hi"}\n');
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('formatSseEvent splits multi-line data', () => {
    const frame = formatSseEvent({ data: 'a\nb' });
    expect(frame).toBe('data: a\ndata: b\n\n');
  });

  it('chunkText splits deterministically', () => {
    expect(chunkText('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
  });
});

describe('handleChatStream events', () => {
  it('yields meta → token+ → done', async () => {
    const provider = new MockProvider();
    const corpus = await loadCorpus();
    const events = [];
    for await (const evt of handleChatStream(
      provider,
      corpus,
      { message: 'How long does standard ground shipping take?' },
      { chunkSize: 8 },
    )) {
      events.push(evt);
    }
    expect(events[0]?.type).toBe('meta');
    expect(events.at(-1)?.type).toBe('done');
    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(0);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    const rejoined = tokens.map((t) => (t.type === 'token' ? t.text : '')).join('');
    expect(rejoined).toBe(done.answer);
  });
});

describe('POST /chat/stream HTTP SSE', () => {
  it('returns text/event-stream with event/data frames', async () => {
    const provider = new MockProvider();
    const corpus = await loadCorpus();
    const server = createGatewayServer({ provider, corpus, topK: 3 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    const port = addr.port;

    try {
      const body = JSON.stringify({
        message: 'How long does standard ground shipping take?',
      });
      const res = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toMatch(/text\/event-stream/);
      const text = await res.text();
      expect(text).toContain('event: meta\n');
      expect(text).toContain('event: token\n');
      expect(text).toContain('event: done\n');
      expect(text).toMatch(/data: \{.*"type":"token".*\}\n/);
      // Existing JSON /chat still works alongside stream.
      const chatRes = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(chatRes.status).toBe(200);
      const json = (await chatRes.json()) as { answer: string };
      expect(json.answer.length).toBeGreaterThan(10);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});

