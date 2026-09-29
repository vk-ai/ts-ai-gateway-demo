import { useCallback, useRef, useState } from 'react';
import { consumeChatSse } from '@gateway/clientStream';

type Citation = {
  index: number;
  id?: string;
  source?: string;
  text?: string;
  score?: number;
};

type Retrieved = {
  id?: string;
  source?: string;
  text?: string;
  score?: number;
};

function renderSnippet(text: string | undefined): string {
  const t = text || '';
  return t.slice(0, 220) + (t.length > 220 ? '…' : '');
}

export default function App() {
  const [question, setQuestion] = useState('How long does standard ground shipping take?');
  const [citations, setCitations] = useState<Citation[] | null>(null);
  const [citationHint, setCitationHint] = useState('(none yet — run SSE stream)');
  const [live, setLive] = useState('(idle)');
  const [out, setOut] = useState('{}');
  const [ttftLabel, setTtftLabel] = useState('TTFT: —');
  const [jsonBusy, setJsonBusy] = useState(false);
  const [streamBusy, setStreamBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const showCitations = useCallback((list: Citation[] | null, emptyMsg: string) => {
    if (!list || !list.length) {
      setCitations(null);
      setCitationHint(emptyMsg);
      return;
    }
    setCitations(list);
    setCitationHint('');
  }, []);

  const askJson = useCallback(async () => {
    setJsonBusy(true);
    setOut('Loading…');
    showCitations(null, '(JSON path — use SSE for citation cards)');
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });
      const data = (await res.json()) as {
        retrieved?: Retrieved[];
        [key: string]: unknown;
      };
      setOut(JSON.stringify(data, null, 2));
      if (data.retrieved) {
        showCitations(
          data.retrieved.map((r, i) => ({
            index: i + 1,
            id: r.id,
            source: r.source,
            text: r.text,
            score: r.score,
          })),
          '(no citations in this response)',
        );
      }
    } catch (err) {
      setOut(String(err));
    } finally {
      setJsonBusy(false);
    }
  }, [question, showCitations]);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const askStream = useCallback(async () => {
    setStreamBusy(true);
    setLive('');
    setTtftLabel('TTFT: …');
    showCitations(null, 'Waiting for citations event…');
    setOut('Streaming…');
    const events: { event: string; data: string }[] = [];
    const ac = new AbortController();
    abortRef.current = ac;
    let ttftMs: number | null = null;

    try {
      const sample = await consumeChatSse(
        '/chat/stream',
        { message: question },
        {
          signal: ac.signal,
          handlers: {
            onEvent: (event, data) => {
              events.push({ event, data });
              try {
                const parsed = JSON.parse(data) as {
                  type?: string;
                  citations?: Citation[];
                };
                // Citations-first: render cards as soon as the early SSE event arrives.
                // Citations do NOT count as TTFT — first token text does (via consumeChatSse).
                if (parsed.type === 'citations' && Array.isArray(parsed.citations)) {
                  showCitations(parsed.citations, '(no citations in this response)');
                }
              } catch {
                /* ignore non-JSON comment frames */
              }
            },
            onFirstToken: (ms) => {
              ttftMs = ms;
              setTtftLabel(`TTFT: ${ms.toFixed(1)} ms`);
            },
            onToken: (text) => {
              setLive((prev) => prev + text);
            },
          },
        },
      );
      ttftMs = sample.ttftMs;
      if (sample.aborted) {
        setTtftLabel(
          (ttftMs != null ? `TTFT: ${ttftMs.toFixed(1)} ms` : 'TTFT: —') + ' (stopped)',
        );
        setOut(
          JSON.stringify(
            {
              aborted: true,
              ttft_ms: ttftMs,
              partial: sample.text,
              events,
            },
            null,
            2,
          ),
        );
      } else {
        setOut(JSON.stringify({ ttft_ms: ttftMs, events }, null, 2));
        if (ttftMs == null) setTtftLabel('TTFT: (no token)');
      }
    } catch (err) {
      setOut(String(err));
      setTtftLabel('TTFT: error');
    } finally {
      abortRef.current = null;
      setStreamBusy(false);
    }
  }, [question, showCitations]);

  return (
    <>
      <h1>ts-ai-gateway-demo (React)</h1>
      <p className="meta">
        Tiny Vite + React UI → <code>POST /chat</code> or streaming{' '}
        <code>POST /chat/stream</code> (SSE). Reuses <code>src/clientStream.ts</code> for TTFT +
        AbortController. Default provider is offline <strong>mock</strong>.{' '}
        <a href="/">← static HTML UI</a>
      </p>
      <div className="banner">
        <strong>OSS / learning portfolio demo only.</strong> Not employer production software. Does
        not claim any employer production experience.
      </div>

      <label htmlFor="q">Question</label>
      <textarea
        id="q"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="e.g. How long does standard shipping take?"
      />

      <div className="row">
        <button type="button" onClick={askJson} disabled={jsonBusy || streamBusy}>
          Ask (JSON)
        </button>
        <button
          type="button"
          className="secondary"
          onClick={askStream}
          disabled={jsonBusy || streamBusy}
        >
          Ask (SSE stream)
        </button>
        <button type="button" className="danger" onClick={stopStream} disabled={!streamBusy}>
          Stop
        </button>
        <span className="ttft" title="Client TTFT: fetch start → first token text">
          {ttftLabel}
        </span>
      </div>

      <h2>Citations</h2>
      {citations ? (
        <div className="citations">
          {citations.map((c) => (
            <article key={c.index} className="cite-card">
              <header>
                <span>
                  <span className="badge">[{c.index}]</span>{' '}
                  <span className="src">{c.source || c.id}</span>
                </span>
                <span className="score">score {Number(c.score ?? 0).toFixed(3)}</span>
              </header>
              <div className="snippet">{renderSnippet(c.text)}</div>
            </article>
          ))}
        </div>
      ) : (
        <div className="cite-empty">{citationHint}</div>
      )}

      <h2>Stream live</h2>
      <div className="stream-live">{live}</div>

      <h2>Response</h2>
      <pre className="out">{out}</pre>
    </>
  );
}
