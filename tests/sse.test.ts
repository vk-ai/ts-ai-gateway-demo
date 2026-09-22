import { describe, expect, it } from 'vitest';
import { handleChatStream, toCitationCards } from '../src/chat.js';
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

describe('toCitationCards', () => {
  it('maps retrieved chunks to 1-based citation cards', () => {
    const cards = toCitationCards([
      { id: 'a#0', source: 'a.md', text: 'hello', score: 0.9 },
      { id: 'b#0', source: 'b.md', text: 'world', score: 0.5 },
    ]);
    expect(cards).toEqual([
      { index: 1, id: 'a#0', source: 'a.md', text: 'hello', score: 0.9 },
      { index: 2, id: 'b#0', source: 'b.md', text: 'world', score: 0.5 },
    ]);
  });
});

describe('handleChatStream events', () => {
  it('yields meta → citations → token+ → done (citations before tokens)', async () => {
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
    expect(events[1]?.type).toBe('citations');
    const types = events.map((e) => e.type);
    const citationsIdx = types.indexOf('citations');
    const firstTokenIdx = types.indexOf('token');
    expect(citationsIdx).toBeGreaterThanOrEqual(0);
    expect(firstTokenIdx).toBeGreaterThan(citationsIdx);
    expect(events.at(-1)?.type).toBe('done');

    const citationsEvt = events[1];
    if (citationsEvt?.type !== 'citations') throw new Error('expected citations');
    expect(citationsEvt.citations.length).toBeGreaterThan(0);
    expect(citationsEvt.citations[0]?.index).toBe(1);
    expect(citationsEvt.citations[0]?.source).toBeTruthy();

    const tokens = events.filter((e) => e.type === 'token');
    expect(tokens.length).toBeGreaterThan(0);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    const rejoined = tokens.map((t) => (t.type === 'token' ? t.text : '')).join('');
    expect(rejoined).toBe(done.answer);
    expect(done.citations.length).toBe(citationsEvt.citations.length);
  });
});

describe('POST /chat/stream HTTP SSE', () => {
  it('returns text/event-stream with citations before token frames', async () => {
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
      expect(text).toContain('event: citations\n');
      expect(text).toContain('event: token\n');
      expect(text).toContain('event: done\n');
      expect(text).toMatch(/data: \{.*"type":"citations".*\}\n/);
      expect(text).toMatch(/data: \{.*"type":"token".*\}\n/);

      const citePos = text.indexOf('event: citations\n');
      const tokenPos = text.indexOf('event: token\n');
      expect(citePos).toBeGreaterThan(-1);
      expect(tokenPos).toBeGreaterThan(citePos);

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
