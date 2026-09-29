# ts-ai-gateway-demo

> **OSS / learning portfolio demo only.**  
> This repository is a personal open-source learning project. It is **not** employer production software, was **not** built for any employer production system, and must **never** be cited as Lowe's (or any other employer) production experience.

Small TypeScript/Node AI gateway that wires together:

1. An **LLM provider interface** — default **`mock`** (offline, deterministic); optional **OpenAI** when `OPENAI_API_KEY` is set  
2. **Simple RAG** — bag-of-words + cosine similarity over a fixture markdown/txt corpus under `data/` (no vector DB)  
3. A **minimal HTTP API** (`node:http`) — `POST /chat` / `POST /query` (JSON) plus **`POST /chat/stream` (SSE)** return answer + retrieved context + groundedness metric  
4. **Offline eval tests** — groundedness / keyword overlap with Vitest (pass without any API keys)  
5. A tiny static HTML page **and** an optional React (Vite) client to hit the API  

## Quick start

```bash
npm install
npm test          # offline — mock provider only
npm run dev       # http://localhost:3000
```

Open http://localhost:3000 for the mini UI, or:

```bash
curl -s http://localhost:3000/health

curl -s -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"How long does standard ground shipping take?"}'

# SSE stream (framing demo)
curl -sN -X POST http://localhost:3000/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"How long does standard ground shipping take?"}'
```

Production-ish build:

```bash
npm run build
npm start
```

## Configuration

Copy `.env.example` to `.env` if you want local overrides (the server reads `process.env` directly):

| Variable         | Default     | Notes                                      |
|------------------|-------------|--------------------------------------------|
| `PORT`           | `3000`      | HTTP port                                  |
| `LLM_PROVIDER`   | `mock`      | `mock` or `openai`                         |
| `OPENAI_API_KEY` | _(empty)_   | Required only for `openai`                 |
| `OPENAI_MODEL`   | `gpt-4o-mini` | Used when provider is openai             |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `LLM_FALLBACKS`  | _(unset)_   | Ordered chain, e.g. `openai,mock` (see below) |
| `RAG_TOP_K`      | `3`         | Chunks retrieved per query                 |

Without an API key the gateway **always** stays on the mock provider — safe for CI and demos.

## API

### `POST /chat` / `POST /query`

```json
{ "message": "What is the return window?", "topK": 3 }
```

Response shape:

```json
{
  "answer": "Based on the retrieved documentation: …",
  "retrieved": [
    { "id": "returns.md#0", "source": "returns.md", "text": "…", "score": 0.42 }
  ],
  "provider": "mock",
  "model": "mock-v1",
  "metrics": { "groundedness": 0.71, "retrievedCount": 3 }
}
```

### `POST /chat/stream` (SSE)

Same JSON body as `/chat`. Responds with `text/event-stream` frames. **Citations arrive early** (before token deltas) so the static UI can render source cards first — the citations-first pattern learners hit with Azure OpenAI / rag-chat-ui style clients:

```text
event: meta
data: {"type":"meta","provider":"mock","model":"mock-v1","retrievedCount":3}

event: citations
data: {"type":"citations","citations":[{"index":1,"id":"shipping-policy.md#0","source":"shipping-policy.md","text":"…","score":0.42}]}

event: token
data: {"type":"token","text":"Based on "}

event: done
data: {"type":"done","answer":"…","citations":[…],"metrics":{…},…}
```

`public/index.html` renders **citation cards** as soon as the `citations` event arrives (before tokens append to the live pane).

Teaching note: the mock (and optional OpenAI) path still **completes first**, then chunks the answer for SSE framing practice — this is **not** true token-by-token provider streaming. Existing `POST /chat` is unchanged.

### `GET /health`

Liveness + provider/chunk counts.

## Project layout

```
data/                 fixture corpus (md/txt)
src/
  providers/          LlmProvider + mock + openai + fallback chain + flaky mock
  rag/                corpus load + cosine retrieve + metrics
  chat.ts             retrieve → prompt → complete
  clientStream.ts     browser SSE helpers (TTFT + AbortController)
  index.ts            HTTP server + static UI (+ /react/ assets)
public/index.html     static teaching UI
public/react/         built React client (gitignored — run client:build)
client/               Vite + React + TypeScript teaching UI (optional deps)
tests/                vitest groundedness / retrieval / provider
ci/github-actions.yml (mirrored to `.github/workflows/ci.yml` for Actions)
```

## Tests & CI

```bash
npm test
npm run typecheck
npm run build
```

All tests run **offline** with the mock provider. The workflow YAML lives under `ci/github-actions.yml` (mirrored for PATs that lack the `workflow` scope for `.github/workflows`).


## Provider fallback chain + retry/backoff

Set `LLM_FALLBACKS` to wrap providers in an ordered **`FallbackProvider`** (`src/providers/fallback.ts`). When it is unset, nothing changes.

| Upstream result | Action |
|---|---|
| `429`, `408`, `5xx`, per-attempt timeout, network error | **retry** the same provider with jittered exponential backoff (`base·2^n`, capped, "equal jitter"). An upstream **`Retry-After`** (seconds or HTTP-date) is honoured exactly; if it is longer than `LLM_MAX_RETRY_AFTER_MS`, the chain skips to the next provider instead of waiting |
| `401` / `403` / `404` | no retry → **next provider** (provider-specific config problem) |
| `400` / `422` / other 4xx | **stop** (the request is bad; another provider would reject it too) |

**Streams:** a fallback is allowed only **before the first token**. Each stream attempt must open *and* deliver its first token within `LLM_TIMEOUT_MS`. Only then does the gateway emit `meta` (naming the provider that actually serves) and `citations`. If the provider drops **after** tokens were sent, you get an SSE `error` frame with `"afterFirstToken": true` and the `partialAnswer`. The gateway never splices a second model's text onto the first model's partial answer.

Responses gain a `routing` block with `servedBy` and `attempts[]` (provider, attempt, outcome, status, delayMs). If the whole chain fails, `/chat` returns **502** with the attempt trail.

```bash
# Deterministic demo: the flaky mock returns 429 (Retry-After: 1) then 503 twice, then the chain falls back to mock
LLM_FALLBACKS=flaky,mock FLAKY_FAULTS=429:1,503,503 npm run dev
curl -s -X POST localhost:3000/chat -H 'Content-Type: application/json' \
  -d '{"message":"What is the return window?"}' | jq .routing

# Mid-stream drop: 2 tokens, then an `error` frame (no fallback)
LLM_FALLBACKS=flaky,mock FLAKY_FAULTS=drop@2 npm run dev
curl -sN -X POST localhost:3000/chat/stream -H 'Content-Type: application/json' \
  -d '{"message":"What is the return window?"}'
```

`FLAKY_FAULTS` tokens (consumed one per call, then every call succeeds): `429`, `429:<retry-after-sec>`, `500`/`503`/`401`/`400`…, `timeout`, `network`, `drop@N`. `OPENAI_BASE_URL` points the OpenAI provider at any OpenAI-compatible server, for example a local stub that injects faults. Other tuning variables: `LLM_MAX_RETRIES` (2), `LLM_TIMEOUT_MS` (15000), `LLM_BACKOFF_BASE_MS` (250), `LLM_BACKOFF_MAX_MS` (4000), `LLM_MAX_RETRY_AFTER_MS` (10000).

```bash
npx vitest run tests/fallback.test.ts
```

> **Honesty:** teaching wrapper with in-process state only. It is not LiteLLM / Portkey / Vercel AI Gateway, and has no circuit breaker shared across instances. Motivation: [vercel/ai#2636](https://github.com/vercel/ai/issues/2636) (retry strategies and fallbacks), [vercel/ai PR #15381](https://github.com/vercel/ai/pull/15381), and the LiteLLM streaming-fallback bugs [#22296](https://github.com/BerriAI/litellm/issues/22296) / [#28216](https://github.com/BerriAI/litellm/issues/28216).

## Client TTFT + Stop (AbortController)

Server streaming already exists; this teaches the **client** product lesson:

- **TTFT badge** — `performance.now()` from fetch start → first `token` text
  (citations-first SSE frames do **not** count as TTFT)
- **Stop** — `AbortController` wired through `fetch` so the user can cancel mid-stream
  and keep partial text

Helpers live in `src/clientStream.ts` (vitest-covered); the static UI in
`public/index.html` mirrors the same pattern.

```bash
npm test
npm run dev
# open the UI → Ask (SSE stream) → watch TTFT; hit Stop mid-stream
```

> **Honesty:** Static HTML teaching UI — not a production chat product. Mock still
> completes-then-chunks (not true provider token streaming). Community refs:
> [promptfoo TTFT](https://github.com/promptfoo/promptfoo/pull/5680),
> [AI SDK stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams).


## React client (optional Vite UI)

A tiny **React + Vite + TypeScript** teaching UI lives under `client/`. It mirrors the
static page (JSON chat, SSE stream with citations-first cards, TTFT badge, Stop via
AbortController) and **reuses** `src/clientStream.ts` via a Vite alias — React is
**not** a root dependency.

`public/react/` is **gitignored**. Build the client when you want `/react/` served by
the gateway; if the build is missing, `GET /react/` returns a JSON 404 with a build hint
while `GET /` (static HTML) still works.

### Dev (gateway + Vite)

```bash
# terminal 1 — gateway on :3000
npm install
npm run dev

# terminal 2 — Vite on :5173 (proxies /chat, /chat/stream, /query, /health → :3000)
npm run client:dev
# open http://localhost:5173/react/
```

### Production-ish (gateway serves built assets)

```bash
npm run client:build   # installs nothing at root; needs client/node_modules
npm run build && npm start
# open http://localhost:3000/react/
```

Or after a one-time `npm --prefix client install`, use the same `client:build` script.

Root `npm test` / `npm run typecheck` / `npm run build` do **not** require
`client/node_modules`. CI stays on root tests only; build the client locally (or add a
CI job later) when you care about the React UI.

> **Honesty:** Optional React teaching shell — not a production chat product. Same mock
> completes-then-chunks SSE framing as the static UI.

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer (again)

Portfolio / educational demo for learning TypeScript AI service patterns (provider abstraction, lightweight RAG, HTTP API, eval metrics). **Not** a production deployment guide. **Not** affiliated with or representing any employer.
