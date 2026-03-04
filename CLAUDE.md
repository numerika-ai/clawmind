# memory-unified — OpenClaw Plugin

## Overview
Unified memory for OpenClaw agents: SQLite (structured) + vector search (semantic) + Qwen3 embeddings (free, local).

**Repo:** https://github.com/numerika-ai/openclaw-memory-unified
**Docs:** docs/ARCHITECTURE.md (current state + migration plan)

## Architecture
- **Runtime:** Node.js (OpenClaw extension)
- **Database:** SQLite (better-sqlite3) + FTS5
- **Vectors:** Currently hnswlib-node (migrating to LanceDB)
- **Embeddings:** Qwen3-Embedding 8B via Ollama (Spark, 192.168.1.80:11434)
- **Dimensions:** 4096

## Code Structure
```
src/                        ← Modular source (target)
  config.ts                 ← Config schema + validation
  daemon.ts                 ← Daemon service
  migrate.ts                ← Schema migrations
  types.ts                  ← Type definitions
  db/
    lancedb.ts              ← LanceDB vector store (Phase 2)
  embedding/
    ollama.ts               ← Ollama/Qwen embeddings
    provider.ts             ← Abstract embedding interface
  hooks/
    on-turn-end.ts          ← Agent end hook (conversations, patterns)
    rag-injection.ts        ← Before agent start RAG injection
  tools/
    unified-search.ts       ← Search tool
    unified-store.ts        ← Store tool
    unified-conversations.ts ← Conversations tool
  utils/
    helpers.ts              ← Tag classification, utilities
    hnsw.ts                 ← HNSW vector operations (to be replaced)

index.ts                    ← Current monolith (897 lines, compiles to dist/)
dist/index.js               ← Compiled monolith (what actually runs)
docs/
  ARCHITECTURE.md           ← Full architecture + migration plan
  CHANGELOG.md              ← Version history
  CUDA-SETUP.md             ← GPU embedding setup
```

## Current State
- `dist/index.js` is compiled from root `index.ts` (monolith)
- `src/` has modular structure but is NOT yet wired as entry point
- Phase 2 will: finish modularization + replace hnswlib-node with LanceDB

## Build
```bash
npm run build    # tsc → dist/
```

## Key Constraint
- **DO NOT break dist/index.js** — it's the running production plugin
- Test changes by restarting gateway: `openclaw gateway restart`
