# Unified Memory — Architecture

**Version:** 3.0 (target)
**Current:** 2.2 (LanceDB + SQLite, partially modularized)
**Last Updated:** 2026-03-04

## Current State (v2.2)

```
┌──────────────────────────────────────────────────────────────┐
│                  memory-unified plugin                        │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  SQLite + FTS5   │  │  LanceDB         │                 │
│  │  skill-memory.db │  │  memory-vectors  │                 │
│  │                  │  │  .lance (35MB)   │                 │
│  │  2101 entries    │  │  1109 vectors    │                 │
│  │  6 entry types   │  │  4096-dim Qwen3  │                 │
│  │  27 skills       │  │  disk-based      │                 │
│  │  23 convos       │  │  filtered search │                 │
│  │  204 patterns    │  │                  │                 │
│  │  FTS5 keyword    │  │  hnsw_meta:      │                 │
│  │  search          │  │  2051 tracked    │                 │
│  └──────────────────┘  └──────────────────┘                 │
│           ↑                     ↑                            │
│           │                     │                            │
│  Structured data         Semantic search                     │
│  (skills, convos,        (embeddings from                    │
│   tool calls, entries)    Spark/Ollama)                      │
└──────────────────────────────────────────────────────────────┘
                              │
                    Qwen3-Embedding 8B
                    Spark (192.168.1.80:11434)
                    4096 dimensions

Orphaned/dead:
  - skill-memory.hnsw (103MB) — old hnswlib index, no longer read by plugin
  - Ruflo MCP bridge — createRufloFromApi() in index.ts, server not running
  - src/daemon.ts — file queue watcher, never used
  - src/migrate.ts — one-time migration script, references old paths
  - src/utils/hnsw.ts — NativeHnswManager, not imported by anyone
```

### Entry type distribution

| entry_type | count | avg content length |
|------------|------:|-------------------:|
| tool       | 1,416 | 722 chars          |
| history    |   428 | 414 chars          |
| config     |   139 | 1,090 chars        |
| skill      |   100 | 3,692 chars        |
| task       |    13 | 351 chars          |
| protocol   |     5 | 847 chars          |
| **total**  | **2,101** |               |

### What works
- SQLite structured storage — entries, skills, conversations, patterns
- FTS5 keyword search — skill matching in before_agent_start RAG
- LanceDB vector search — 1109 vectors, used in RAG pipeline
- Qwen3 embeddings — remote on Spark, 4096-dim
- Tool call logging — auto-logs state-changing tools
- Conversation tracking — groups messages into threads (23 active)
- Skill pattern learning — 204 patterns, confidence-based matching
- Background bulk indexing — indexes unembedded entries on startup

### What's broken/orphaned
- Ruflo MCP — dead code, createRufloFromApi() always fails silently (server not running)
- src/utils/hnsw.ts — NativeHnswManager class, not imported anywhere
- src/daemon.ts — file queue watcher, references `/home/hermes/` paths
- src/migrate.ts — one-time migration script, references old paths
- skill-memory.hnsw — 103MB file on disk, no longer loaded
- Duplicate Qwen embed code — qwenEmbed() in both index.ts and src/embedding/ollama.ts

### Code structure (actual)

Root `index.ts` (897 lines) is the monolith. It compiles to `dist/index.js` (1501 lines).
It already imports from `src/` modules, but still contains substantial inline code:

**Already modularized (imported from src/):**
- `src/config.ts` (62 lines) — config schema + validation
- `src/types.ts` (56 lines) — shared interfaces
- `src/tools/unified-search.ts` (40 lines) — search tool
- `src/tools/unified-store.ts` (60 lines) — store tool
- `src/tools/unified-conversations.ts` (52 lines) — conversations tool
- `src/hooks/rag-injection.ts` (292 lines) — before_agent_start RAG
- `src/hooks/on-turn-end.ts` (366 lines) — tool call log + agent end
- `src/utils/helpers.ts` (134 lines) — chunking, tagging, utilities
- `src/db/lancedb.ts` (185 lines) — LanceVectorStore class

**Still inline in root index.ts (~600 lines):**
- `createRufloFromApi()` — Ruflo MCP bridge (~110 lines, dead code)
- `qwenEmbed()`, `cosineSim()`, `loadSkillEmbeddings()`, `qwenSemanticSearch()` (~75 lines, duplicated)
- `NativeLanceManager` — wrapper around LanceVectorStore (~150 lines)
- `UnifiedDBImpl` — SQLite database class (~180 lines)
- `createUnifiedIndexFilesTool()` — file indexing tool (~90 lines)
- `memoryUnifiedPlugin` — plugin registration/wiring (~50 lines)

**Not imported by anyone (dead modules):**
- `src/utils/hnsw.ts` (184 lines) — NativeHnswManager (old hnswlib-node)
- `src/daemon.ts` (84 lines) — file queue watcher
- `src/migrate.ts` (108 lines) — USMD → Ruflo migration
- `src/embedding/provider.ts` (7 lines) — abstract interface, unused

### Build state

**WARNING:** `src/db/lancedb.ts` has uncommitted changes that rename `LanceVectorStore` → `LanceManager` and change the API. Root `index.ts` still imports `LanceVectorStore`. Running `npm run build` will fail until either:
1. The uncommitted changes are reverted, or
2. Root index.ts is updated to use the new `LanceManager` API

The current `dist/index.js` was compiled before this change and works correctly.

## Target State (v3.0) — SQLite + LanceDB

```
┌──────────────────────────────────────────────────────────────┐
│                  memory-unified plugin v3                     │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  SQLite + FTS5   │  │  LanceDB         │                 │
│  │  skill-memory.db │  │  memory-vectors  │                 │
│  │                  │  │  .lance/         │                 │
│  │  Structured data │  │  4096-dim Qwen3  │                 │
│  │  • entries       │  │  Arrow/Parquet   │                 │
│  │  • skills        │  │  Disk-based      │                 │
│  │  • conversations │  │  Filtered search │                 │
│  │  • patterns      │  │  Delete/update   │                 │
│  │  • FTS5 index    │  │  Scales to 1M+   │                 │
│  └────────┬─────────┘  └────────┬─────────┘                 │
│           │    Shared key:      │                            │
│           └──── entry_id ───────┘                            │
│                                                              │
│  Removed: hnswlib-node, Ruflo MCP, skill-memory.hnsw        │
│  Entry point: src/index.ts (modular)                         │
└──────────────────────────────────────────────────────────────┘
```

### Why LanceDB over hnswlib-node

| Feature          | hnswlib-node              | LanceDB                     |
|------------------|---------------------------|------------------------------|
| Storage          | In-memory (103MB RAM)     | Disk-based (35MB on disk)    |
| Startup          | Load entire index         | Lazy, mmap                   |
| Filtering        | None                      | Native WHERE clauses         |
| Delete/update    | Not supported             | Supported                    |
| Concurrent reads | No                        | Yes                          |
| Scale            | ~10K practical            | 1M+ vectors                  |
| Dependencies     | hnswlib-node (native)     | @lancedb/lancedb (installed) |
| Maintenance      | Custom class (150 LOC)    | Standard API                 |

### What stays the same
- SQLite schema (unified_entries, skills, conversations, etc.)
- FTS5 skill matching in before_agent_start
- Qwen3 embeddings from Spark/Ollama
- Tool call logging hooks
- Conversation tracking
- All 4 agent tools (unified_search, unified_store, unified_conversations, unified_index_files)

### File-based memory (MEMORY.md, daily notes)
Current role: agent continuity between sessions.
These are workspace config loaded by OpenClaw core, not by this plugin.
Plan: keep for now. Phase 4 may replace daily notes with DB queries.

## Completed Work

### Phase 1: Documentation + Cleanup ✅
- Documented current state accurately (this file)
- Documented target state with LanceDB migration plan
- Cleaned up .bak files, root duplicates, dead Ruflo/SONA refs from repo
- Updated README.md to match reality

### Phase 2: LanceDB Integration ✅ (partial)
- Installed `@lancedb/lancedb` npm package
- Created `src/db/lancedb.ts` with LanceVectorStore class
- Created `NativeLanceManager` in root index.ts wrapping LanceVectorStore
- LanceDB storing vectors: 1109 vectors in `memory-vectors.lance` (35MB)
- Background bulk indexing working: 2051/2101 entries tracked in hnsw_meta
- `dist/index.js` compiled and running in production with LanceDB

### Phase 1.5: Modularization (partial) ✅
- Extracted tools → `src/tools/unified-{search,store,conversations}.ts`
- Extracted hooks → `src/hooks/{rag-injection,on-turn-end}.ts`
- Extracted utils → `src/utils/helpers.ts`
- Extracted config → `src/config.ts`
- Extracted types → `src/types.ts`
- Root index.ts now imports from all of these

## Remaining Work

### Part A: Fix Build (immediate)

The uncommitted `src/db/lancedb.ts` change breaks `npm run build`. Two options:

**Option 1 (quick):** Revert the uncommitted lancedb.ts change. Keep `LanceVectorStore` until modularization is done.

**Option 2 (forward):** Update root index.ts to use the new `LanceManager` API from the rewritten lancedb.ts. This means:
1. Remove `NativeLanceManager` class from root index.ts (150 lines)
2. Import `LanceManager` from `./src/db/lancedb`
3. Adapt the constructor call (LanceManager takes lancePath + sqlDb + logger, does its own init)
4. Remove inline `qwenEmbed()` from root index.ts (LanceManager embeds internally)
5. Rebuild dist/index.js

### Part B: Finish Modularization

Move remaining inline code from root index.ts to src/ modules:

1. **`src/db/sqlite.ts`** — Move `UnifiedDBImpl` class (~180 lines)
   - SQLite connection, table creation, migrations
   - storeEntry(), searchEntries(), getSkillByName(), listSkills()

2. **`src/tools/unified-index-files.ts`** — Move file indexing tool (~90 lines)

3. **`src/embedding/ollama.ts`** — Already exists but root index.ts has its own copy
   - Merge: keep src/ version, delete inline copy from root
   - Ensure hooks/rag-injection.ts uses the src/ version

4. **`src/index.ts`** — New modular entry point
   - Import everything from src/ modules
   - Wire up plugin registration (register hooks, tools, service)
   - Export `memoryUnifiedPlugin` as default

5. **Update `tsconfig.json`** — Point compilation at `src/index.ts` instead of root `index.ts`

6. **Delete root `index.ts`** — After verifying src/index.ts compiles and runs correctly

### Part C: Dead Code Removal

1. Delete `src/utils/hnsw.ts` — NativeHnswManager, not imported
2. Delete `src/daemon.ts` — file queue watcher, never used
3. Delete `src/migrate.ts` — one-time migration, references old paths
4. Delete `src/embedding/provider.ts` — abstract interface, unused
5. Delete `createRufloFromApi()` from root index.ts — Ruflo MCP server not running
6. Remove `hnswlib-node` from package.json dependencies
7. Delete `skill-memory.hnsw` (103MB freed)
8. Remove all `if (ruflo)` dead branches from hooks

### Part D: Enhanced Search (future)

1. unified_search tool → real semantic search via LanceDB
2. Filtered search: `tbl.search(vector).where("entry_type = 'skill'").limit(N)`
3. Deduplicate tool entries (1,416 entries, many redundant)
4. Optional: replace daily notes with DB-backed recall

## LanceDB Schema

```
Table: vectors
├── entry_id: int64          (FK → unified_entries.id)
├── text: string             (content snippet, max 500 chars)
├── vector: float32[4096]    (Qwen3 embedding)
├── entry_type: string       (skill/history/tool/config/etc.)
├── tags: string             (comma-separated)
└── created_at: string       (ISO timestamp)
```

## Infrastructure

| Component  | Host                  | Details                                    |
|------------|-----------------------|--------------------------------------------|
| SQLite DB  | Tank (192.168.1.100)  | ~/.openclaw/workspace/skill-memory.db      |
| LanceDB    | Tank (192.168.1.100)  | ~/.openclaw/workspace/memory-vectors.lance |
| HNSW (dead)| Tank (192.168.1.100)  | ~/.openclaw/workspace/skill-memory.hnsw    |
| Embeddings | Spark (192.168.1.80)  | Ollama, qwen3-embedding:8b, port 11434    |
| Plugin     | Tank                  | ~/.openclaw/extensions/memory-unified/     |

## Key Files

| File                          | Lines | Purpose                                    |
|-------------------------------|------:|--------------------------------------------|
| index.ts                      |   897 | Monolith entry point (compiles to dist/)   |
| dist/index.js                 | 1,501 | Compiled plugin (what runs in production)  |
| src/config.ts                 |    62 | Config schema + validation                 |
| src/types.ts                  |    56 | Shared type definitions                    |
| src/db/lancedb.ts             |   185 | LanceDB vector store (uncommitted rewrite) |
| src/embedding/ollama.ts       |    93 | Qwen3 embedding via Ollama                 |
| src/embedding/provider.ts     |     7 | Abstract interface (unused)                |
| src/hooks/rag-injection.ts    |   292 | before_agent_start RAG injection           |
| src/hooks/on-turn-end.ts      |   366 | Tool call logging + agent end              |
| src/tools/unified-search.ts   |    40 | unified_search tool                        |
| src/tools/unified-store.ts    |    60 | unified_store tool                         |
| src/tools/unified-conversations.ts | 52 | unified_conversations tool             |
| src/utils/helpers.ts          |   134 | Chunking, tagging, utilities               |
| src/utils/hnsw.ts             |   184 | NativeHnswManager (dead, not imported)     |
| src/daemon.ts                 |    84 | File queue watcher (dead)                  |
| src/migrate.ts                |   108 | Migration script (dead)                    |
| package.json                  |    22 | Deps: @lancedb/lancedb, better-sqlite3, hnswlib-node |

## Session Log

| Date       | Session | Work Done                                                              |
|------------|---------|------------------------------------------------------------------------|
| 2026-03-01 | Wiki    | Initial architecture, Ruflo MCP bridge fix                             |
| 2026-03-02 | Wiki    | Qwen3 embeddings, NativeHnswManager (Phase 0), skill embedding cache   |
| 2026-03-03 | Wiki    | Phase 1 modularization: extract tools, hooks, helpers, config, types   |
| 2026-03-03 | Wiki    | Phase 2: LanceDB integration, NativeLanceManager wrapping LanceVectorStore |
| 2026-03-04 | Wiki    | Cleanup: remove .bak files, root duplicates, dead Ruflo/SONA refs     |
| 2026-03-04 | Claude  | Full review: real data audit (2101 entries, 1109 vectors), build state analysis, architecture doc rewrite |

---
*Last edited by Claude Code — 2026-03-04 13:30 UTC*

## Troubleshooting

### "plugin not found: memory-unified"

**Symptom:** Gateway logs show `plugins.slots.memory: plugin not found: memory-unified` on every startup.

**Root cause:** OpenClaw's plugin discovery scans `~/.openclaw/extensions/` directories and requires either:
1. An `"openclaw": { "extensions": ["dist/index.js"] }` field in `package.json`, OR
2. A root-level `index.js` file

Since the plugin was modularized (root `index.ts` deleted, entry point moved to `src/index.ts` → `dist/index.js`), neither condition was met. The plugin was invisible to the registry.

**Fix:** Add to `package.json`:
```json
{
  "openclaw": {
    "extensions": ["dist/index.js"]
  }
}
```

### "HNSW store failed" spam in logs

**Symptom:** Logs filled with `memory-unified: HNSW store failed:` every few seconds.

**Root cause:** Legacy Ruflo MCP bridge code tried to POST to `http://127.0.0.1:3002/mcp` (Ruflo server not running). Every tool call triggered a fetch timeout.

**Fix:** Removed in commit `f74eecb` — Ruflo bridge deleted, hnswlib-node uninstalled.

### LanceDB "unified_vectors" table not found

**Symptom:** LanceDB search returns empty results.

**Root cause:** Table auto-creates on first write. If Spark (Qwen3 embeddings at `192.168.1.80:11434`) is unreachable, no vectors get stored.

**Fix:** Verify Spark is up: `curl -s http://192.168.1.80:11434/v1/embeddings -H "Content-Type: application/json" -d '{"model":"qwen3-embedding:8b","input":"test"}'`
