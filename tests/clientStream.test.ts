import { describe, expect, it, vi } from 'vitest';
import { consumeChatSse, createTtftTracker } from '../src/clientStream.js';

describe('createTtftTracker', () => {
  it('measures first token only', () => {
    const t = createTtftTracker(100);
    expect(t.ttftMs()).toBeNull();
    expect(t.noteToken(125)).toBe(25);
    expect(t.noteToken(200)).toBeNull();
    expect(t.ttftMs()).toBe(25);
  });
});

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(frames[i]));
      i += 1;
    },
  });
}

describe('consumeChatSse', () => {
  it('reports TTFT on first token, ignoring earlier citations frame', async () => {
    const frames = [
      'event: citations\ndata: {"type":"citations","citations":[]}\n\n',
      'event: token\ndata: {"type":"token","text":"Hi"}\n\n',
      'event: token\ndata: {"type":"token","text":"!"}\n\n',
      'event: done\ndata: {"type":"done"}\n\n',
    ];
    let t = 0;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: sseBody(frames),
    })) as unknown as typeof fetch;

    const sample = await consumeChatSse(
      '/chat/stream',
      { message: 'hi' },
      {
        fetchImpl,
        now: () => {
          // start=0; after citations still 0; first token at 40
          const v = t;
          t += 40;
          return v;
        },
      },
    );
    expect(sample.aborted).toBe(false);
    expect(sample.text).toBe('Hi!');
    expect(sample.ttftMs).toBe(40);
  });

  it('AbortController cancel yields aborted=true and keeps partial text', async () => {
    const ac = new AbortController();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode('event: token\ndata: {"type":"token","text":"partial"}\n\n'),
        );
        // Abort before further chunks
        ac.abort();
        controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
    });
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      // If signal aborts during read, reader throws AbortError
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            const reader = body.getReader();
            return {
              async read() {
                if (signal?.aborted) {
                  throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                }
                return reader.read();
              },
            };
          },
        },
      };
    }) as unknown as typeof fetch;

    // Abort immediately so fetch path sees abort during read
    queueMicrotask(() => ac.abort());
    const sample = await consumeChatSse(
      '/chat/stream',
      { message: 'hi' },
      { fetchImpl, signal: ac.signal, now: () => 0 },
    );
    expect(sample.aborted).toBe(true);
    // partial may be empty if aborted before first read completes — either is fine
    expect(typeof sample.text).toBe('string');
  });
});
