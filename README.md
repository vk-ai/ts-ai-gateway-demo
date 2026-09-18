# ts-ai-gateway-demo

> **OSS / learning portfolio demo only.**  
> This repository is a personal open-source learning project. It is **not** employer production software, was **not** built for any employer production system, and must **never** be cited as Lowe's (or any other employer) production experience.

Small TypeScript/Node AI gateway that wires together:

1. An **LLM provider interface** — default **`mock`** (offline, deterministic); optional **OpenAI** when `OPENAI_API_KEY` is set  
2. **Simple RAG** — bag-of-words + cosine similarity over a fixture markdown/txt corpus under `data/` (no vector DB)  
3. A **minimal HTTP API** (`node:http`) — `POST /chat` and `POST /query` return answer + retrieved context + groundedness metric  
4. **Offline eval tests** — groundedness / keyword overlap with Vitest (pass without any API keys)  
5. A tiny static HTML page to hit the API  

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

### `GET /health`

Liveness + provider/chunk counts.

## Project layout

```
data/                 fixture corpus (md/txt)
src/
  providers/          LlmProvider + mock + openai
  rag/                corpus load + cosine retrieve + metrics
  chat.ts             retrieve → prompt → complete
  index.ts            HTTP server + static UI
public/index.html     optional tiny client
tests/                vitest groundedness / retrieval / provider
ci/github-actions.yml (mirrored to `.github/workflows/ci.yml` for Actions) CI mirror (copy to .github/workflows if allowed)
```

## Tests & CI

```bash
npm test
npm run typecheck
npm run build
```

All tests run **offline** with the mock provider. The workflow YAML lives under `ci/github-actions.yml` (mirrored for PATs that lack the `workflow` scope for `.github/workflows`).

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer (again)

Portfolio / educational demo for learning TypeScript AI service patterns (provider abstraction, lightweight RAG, HTTP API, eval metrics). **Not** a production deployment guide. **Not** affiliated with or representing any employer.
