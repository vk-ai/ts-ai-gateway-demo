/**
 * Browser/client helpers for SSE chat: TTFT measurement + AbortController cancel.
 * Teaching stub — not a production chat SDK.
 */

export type TtftSample = {
  /** Milliseconds from fetch start to first user-visible token text. */
  ttftMs: number | null;
  /** True when the stream was aborted via AbortSignal. */
  aborted: boolean;
  /** Assembled token text received before end/abort. */
  text: string;
};

export type StreamHandlers = {
  onEvent?: (event: string, data: string) => void;
  onToken?: (text: string) => void;
  /** Called once when the first token text arrives (TTFT boundary). */
  onFirstToken?: (ttftMs: number) => void;
};

/**
 * Measure TTFT as fetch-start → first token text (not merely first SSE frame).
 * Citations-first frames do not count as TTFT.
 */
export function createTtftTracker(startedAtMs: number) {
  let firstTokenAt: number | null = null;
  return {
    noteToken(nowMs: number = performanceNow()): number | null {
      if (firstTokenAt == null) {
        firstTokenAt = nowMs;
        return Math.max(0, firstTokenAt - startedAtMs);
      }
      return null;
    },
    ttftMs(): number | null {
      return firstTokenAt == null ? null : Math.max(0, firstTokenAt - startedAtMs);
    },
  };
}

/** testable clock; browsers use performance.now, Node tests can inject. */
export function performanceNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Consume a POST SSE body with optional AbortSignal.
 * Resolves with TTFT + partial text; on abort sets aborted=true and keeps partial text.
 */
export async function consumeChatSse(
  url: string,
  body: unknown,
  opts: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    now?: () => number;
    handlers?: StreamHandlers;
  } = {},
): Promise<TtftSample> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? performanceNow;
  const started = now();
  const tracker = createTtftTracker(started);
  let text = '';
  let aborted = false;
  let ttftMs: number | null = null;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error('stream HTTP ' + res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const block of parts) {
        const lines = block.split('\n');
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        const data = dataLines.join('\n');
        opts.handlers?.onEvent?.(event, data);
        try {
          const parsed = JSON.parse(data) as { type?: string; text?: string };
          if (parsed.type === 'token' && parsed.text) {
            text += parsed.text;
            const maybe = tracker.noteToken(now());
            if (maybe != null) {
              ttftMs = maybe;
              opts.handlers?.onFirstToken?.(maybe);
            }
            opts.handlers?.onToken?.(parsed.text);
          }
        } catch {
          /* ignore non-JSON comment frames */
        }
      }
    }
  } catch (err) {
    const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : '';
    if (name === 'AbortError' || opts.signal?.aborted) {
      aborted = true;
      ttftMs = tracker.ttftMs();
      return { ttftMs, aborted, text };
    }
    throw err;
  }

  return { ttftMs: ttftMs ?? tracker.ttftMs(), aborted, text };
}
