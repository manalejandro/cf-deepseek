# cf-deepseek

Serve **DeepSeek V4 Flash** from Cloudflare Workers AI behind a Docker Model Runner (DMR)–compatible, OpenAI-compatible API, with **embeddings** and a **Vectorize-backed memory / RAG** layer.

This Worker exposes a base URL like DMR's (`/engines/v1`) so tools such as [opencode](https://opencode.ai) can be pointed at it as a drop-in provider.

## Features

- **Chat completions** (`/engines/v1/chat/completions`) with streaming (SSE), reasoning, and tool/function calling
- **Text completions** (`/engines/v1/completions`)
- **Embeddings** (`/engines/v1/embeddings`) using `@cf/baai/bge-m3` (multilingual, 1024 dims)
- **Vector search memory** backed by Cloudflare Vectorize: upsert, query, delete, describe
- **Optional RAG** injected into chat completions from retrieved context
- API-key authentication and CORS enabled

## Architecture

```
Client (opencode / curl)
   │  POST /engines/v1/chat/completions   (Bearer API_KEY)
   ▼
Cloudflare Worker (cf-deepseek)
   ├── Workers AI  → @cf/deepseek-ai/deepseek-v4-flash-0731 (chat)
   │              → @cf/baai/bge-m3 (embeddings)
   └── Vectorize   → deepseek-memory index (1024 dims, cosine)
```

## Prerequisites

- A Cloudflare account with the **Workers Paid** plan (required by the DeepSeek model)
- [Node.js](https://nodejs.org) and npm
- Wrangler authenticated: `npx wrangler login`

## Setup

```bash
npm install
npx wrangler types
```

Create the Vectorize index (dimensions must match `bge-m3`, 1024):

```bash
npx wrangler vectorize create deepseek-memory --dimensions=1024 --metric=cosine
```

Optional: enable metadata filtering on a property (see [Metadata filtering](#metadata-filtering)):

```bash
npx wrangler vectorize create-metadata-index deepseek-memory --property-name='source' --type='string'
```

### Configuration

`wrangler.jsonc` includes:

| Binding / var       | Value                                        |
| ------------------- | -------------------------------------------- |
| `AI`                | Workers AI binding                            |
| `VECTORIZE`         | `deepseek-memory` index                       |
| `EXPOSED_MODEL`     | `deepseek-v4-flash-cloudflare`                |
| `CLOUDFLARE_MODEL`  | `@cf/deepseek-ai/deepseek-v4-flash-0731`      |
| `EMBEDDING_MODEL`   | `@cf/baai/bge-m3`                             |
| `API_KEY` (secret)  | your API key (see below)                      |

Set the secret used to authenticate API requests:

```bash
echo "pass123" | npx wrangler secret put API_KEY
```

For local development, copy `.dev.vars.example` to `.dev.vars`:

```bash
cp .dev.vars.example .dev.vars
```

### Custom domain

A custom-domain route is declared in `wrangler.jsonc` using `example.com` as a placeholder. Replace it with a zone in your Cloudflare account (e.g. `ai.example.com`), or remove the `routes` block to use the `*.workers.dev` URL:

```jsonc
"routes": [
  {
    "pattern": "ai.example.com",
    "custom_domain": true
  }
]
```

## Deploy

```bash
npm run deploy        # npx wrangler deploy
npm run dev           # local dev server
npm test              # vitest
```

## API

All endpoints live under `/engines/v1` (the `/v1` prefix is also accepted) and require:

```
Authorization: Bearer <API_KEY>
```

### Models

| Method | Path                              | Description                |
| ------ | --------------------------------- | -------------------------- |
| GET    | `/engines/v1/models`              | List models                |
| GET    | `/engines/v1/models/{id}`         | Get model                  |

### Chat / completions

| Method | Path                              | Description                          |
| ------ | --------------------------------- | ------------------------------------ |
| POST   | `/engines/v1/chat/completions`    | Chat completion (stream or not)      |
| POST   | `/engines/v1/completions`         | Text completion                      |

```bash
curl https://example.com/engines/v1/chat/completions \
  -H "Authorization: Bearer pass123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v4-flash-cloudflare",
    "stream": true,
    "messages": [{ "role": "user", "content": "Hola, ¿qué tal?" }]
  }'
```

### Embeddings

| Method | Path                              | Description     |
| ------ | --------------------------------- | --------------- |
| POST   | `/engines/v1/embeddings`          | Embed text      |

```bash
curl https://example.com/engines/v1/embeddings \
  -H "Authorization: Bearer pass123" \
  -H "Content-Type: application/json" \
  -d '{ "input": ["hola mundo", "el clima en Madrid"] }'
```

### Vectorize memory (RAG)

| Method | Path                              | Description                      |
| ------ | --------------------------------- | -------------------------------- |
| GET    | `/engines/v1/vectorize`           | Index info (describe)            |
| POST   | `/engines/v1/vectorize/upsert`    | Embed + store documents          |
| POST   | `/engines/v1/vectorize/query`     | Semantic search                  |
| POST   | `/engines/v1/vectorize/delete`    | Delete vectors by id             |

Upsert:

```bash
curl https://example.com/engines/v1/vectorize/upsert \
  -H "Authorization: Bearer pass123" \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": "docs",
    "documents": [
      { "id": "doc-1", "text": "DeepSeek V4 Flash es un modelo de razonamiento.",
        "metadata": { "source": "manual" } }
    ]
  }'
```

Query:

```bash
curl https://example.com/engines/v1/vectorize/query \
  -H "Authorization: Bearer pass123" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "¿qué modelo de razonamiento aloja Cloudflare?",
    "topK": 3,
    "namespace": "docs",
    "returnMetadata": "all"
  }'
```

### RAG in chat

Add a `vectorize` block to a chat-completion request to retrieve context and inject it automatically:

```json
{
  "model": "deepseek-v4-flash-cloudflare",
  "messages": [{ "role": "user", "content": "Pregunta..." }],
  "vectorize": { "retrieve": true, "topK": 3, "namespace": "docs" }
}
```

## Using with opencode

Point the `dmr` provider at this endpoint as if it were Docker Model Runner:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "dmr": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek V4 Flash Cloudflare",
      "options": {
        "baseURL": "https://example.com/engines/v1",
        "apiKey": "pass123"
      },
      "models": {
        "deepseek-v4-flash-cloudflare": {
          "name": "DeepSeek V4 Flash Cloudflare"
        }
      }
    }
  }
}
```

## Notes

- **Async propagation**: Vectorize mutations (upsert/delete/metadata index) are processed asynchronously; it can take a few seconds (up to ~40 s on cold start) before new vectors are queryable. Check `GET /engines/v1/vectorize` for `vectorCount`.
- **Metadata filtering**: filters in `query` only work on properties that have a metadata index (max 10 per index). Create one with `wrangler vectorize create-metadata-index`, then re-upsert the affected vectors.
- **Fixed dimensions**: a Vectorize index dimension cannot be changed. If you switch `EMBEDDING_MODEL`, recreate the index.
- **Billing**: the DeepSeek and embedding models bill per token. See the Workers AI model catalog.

## Development

```bash
npm run dev
npm test
npx wrangler types   # regenerate types after changing wrangler.jsonc
```

## License

[MIT](LICENSE) © manalejandro