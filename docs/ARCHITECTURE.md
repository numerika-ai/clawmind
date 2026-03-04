# Unified Memory — Architecture

**Version:** 3.0 (target)  
**Current:** 2.1 (hnswlib-node + SQLite)  
**Last Updated:** 2026-03-04

## Current State (v2.1)

```
┌─────────────────────────────────────────────────────────────┐
│                  memory-unified plugin                       │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │  SQLite + FTS5   │  │  hnswlib-node    │                │
│  │  skill-memory.db │  │  skill-memory.   │                │
│  │                  │  │  hnsw (103MB)    │                │
│  │  1773 entries    │  │  1774 vectors    │                │
│  │  8 entry types   │  │  4096-dim Qwen3  │                │
│  │  FTS5 keyword    │  │  cosine search   │                │
│  │  search          │  │  in-memory index │                │
│  └──────────────────┘  └──────────────────┘                │
│           ↑                     ↑                           │
│           │                     │                           │
│  Structured data         Semantic search                    │
│  (skills, convos,        (embeddings from                   │
│   tool calls, entries)    Spark/Ollama)                     │
└─────────────────────────────────────────────────────────────┘
                              │
                    Qwen3-Embedding 8B
                    Spark (192.168.1.80:11434)
                    4096 dimensions

Orphaned:
  - LanceDB (memory-vectors.lance, 596 vectors) — written by Python scripts, never read by plugin
  - Ruflo MCP — referenced in code, process not running
```

### What works
- SQLite structured storage — entries, skills, conversations, patterns
- FTS5 keyword search — skill matching in before_agent_start RAG
- hnswlib-node — semantic search in RAG pipeline (before_agent_start)
- Qwen3 embeddings — remote on Spark, 4096-dim, ~50ms latency
- Tool call logging — auto-logs state-changing tools
- Conversation tracking — groups messages into threads
- Skill pattern learning — confidence-based skill matching

### What's broken/orphaned
- LanceDB — npm package installed, lance table exists, but plugin code doesn't use it
- Ruflo MCP — dead code, ruflo=null, all if(ruflo) blocks are no-ops
- README.md — says "LanceDB vector search" but actual backend is hnswlib-node
- unified_search tool — SQL just returns recent entries (ORDER BY created_at), HNSW part empty

### Problems with hnswlib-node
- In-memory only — 103MB index loaded into RAM on startup
- No filtering — can't filter by entry_type during vector search
- Single-file — no concurrent access, corruption risk
- No delete/update — vectors accumulate forever
- Custom code — NativeHnswManager class (~150 lines) we maintain

## Target State (v3.0) — SQLite + LanceDB

```
┌─────────────────────────────────────────────────────────────┐
│                  memory-unified plugin v3                    │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │  SQLite + FTS5   │  │  LanceDB         │                │
│  │  skill-memory.db │  │  memory-vectors  │                │
│  │                  │  │  .lance/         │                │
│  │  Structured data │  │  4096-dim Qwen3  │                │
│  │  • entries       │  │  Arrow/Parquet   │                │
│  │  • skills        │  │  Disk-based      │                │
│  │  • conversations │  │  Filtered search │                │
│  │  • patterns      │  │  Delete/update   │                │
│  │  • FTS5 index    │  │  Scales to 1M+   │                │
│  └────────┬─────────┘  └────────┬─────────┘                │
│           │    Shared key:      │                           │
│           └──── entry_id ───────┘                           │
│                                                             │
│  Removed: hnswlib-node, Ruflo MCP, skill-memory.hnsw       │
└─────────────────────────────────────────────────────────────┘
```

### Why LanceDB over hnswlib-node

| Feature          | hnswlib-node              | LanceDB                     |
|------------------|---------------------------|------------------------------|
| Storage          | In-memory (103MB RAM)     | Disk-based (Arrow/Parquet)   |
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
- All 3 agent tools (unified_search, unified_store, unified_conversations)

### File-based memory (MEMORY.md, daily notes)
Current role: agent continuity between sessions.
These are workspace config loaded by OpenClaw core, not by this plugin.
Plan: keep for now. Phase 4 may replace daily notes with DB queries.

## Migration Plan

### Phase 1: Documentation ✅
- Document current state accurately (this file)
- Document target state
- Update README.md to match reality

### Phase 2: LanceDB Integration
1. Replace NativeHnswManager class with LanceManager class
2. LanceManager.search() → embed query via qwenEmbed() → tbl.search(vector).limit(N)
3. LanceManager.addEntry() → embed text → tbl.add([row])
4. Init: lancedb.connect(path) → db.openTable('vectors')
5. Handle async init (LanceDB is async, hnswlib was sync)

### Phase 3: Cleanup
1. Remove hnswlib-node from package.json
2. Delete NativeHnswManager class from source
3. Remove all ruflo references (dead code)
4. Delete skill-memory.hnsw (103MB freed)
5. Migrate hnswlib vectors to LanceDB (one-time script)

### Phase 4: Enhanced Search (future)
1. unified_search does real semantic search via LanceDB
2. Filtered search: tbl.search(vector).where("entry_type = 'skill'").limit(N)
3. Deduplicate entries (1092 tool entries, many redundant)
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
| Embeddings | Spark (192.168.1.80)  | Ollama, qwen3-embedding:8b, port 11434    |
| Plugin     | Tank                  | ~/.openclaw/extensions/memory-unified/     |

## Key Files

| File              | Purpose                                          |
|-------------------|--------------------------------------------------|
| src/index.ts      | Plugin source (TypeScript)                       |
| dist/index.js     | Compiled plugin (what runs)                      |
| src/config.ts     | Plugin configuration schema                      |
| package.json      | Dependencies (hnswlib-node + @lancedb/lancedb)   |

---
*Last edited by Wiki — 2026-03-04 10:02 UTC*
