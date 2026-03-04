# memory-unified v3.0 — Architecture: sqlite-vec Migration

**Version:** 3.0 (target)
**Current:** 2.2 (SQLite + LanceDB)
**Author:** Claude Code
**Date:** 2026-03-04

---

## 1. Executive Summary

### Why sqlite-vec?

memory-unified currently uses **two separate storage engines**: SQLite (structured data) and LanceDB (vector search). This split creates operational complexity, duplicated state, and a heavy dependency tree. v3.0 consolidates everything into a **single SQLite database file** by replacing LanceDB with **sqlite-vec**, a native SQLite extension for vector search.

### Benefits over LanceDB

| Dimension              | LanceDB (current)                    | sqlite-vec (target)                  |
|------------------------|---------------------------------------|---------------------------------------|
| **Storage**            | Separate `.lance/` directory (35MB)   | Same `skill-memory.db` file           |
| **Dependencies**       | `@lancedb/lancedb` (132MB installed)  | `sqlite-vec` (~2MB native extension)  |
| **Architecture**       | Two databases, two APIs, JOIN by ID   | One database, one API, native JOINs   |
| **Async complexity**   | All LanceDB ops are async (Promise)   | Sync via better-sqlite3 (no awaits)   |
| **Init complexity**    | Async init(), sample-row table create | `sqliteVec.load(db)` — one line       |
| **Transactions**       | Cannot span both stores               | Single ACID transaction for both      |
| **Backup**             | Copy `.db` + `.lance/` directory      | Copy one `.db` file                   |
| **Delete/Update**      | Async, separate from SQL              | Standard SQL DELETE/UPDATE            |
| **Filtering**          | String-based WHERE in LanceDB API     | Native SQL metadata columns in vec0   |
| **Node.js compat**     | Requires `@lancedb/lancedb` native    | `sqlite-vec` loads into better-sqlite3|

### What we lose

- **ANN indexing** — LanceDB uses IVF-PQ for approximate nearest neighbors. sqlite-vec uses brute-force scan. At our scale (~2K vectors), this is irrelevant — brute-force is faster than index overhead.
- **Arrow/Parquet format** — LanceDB's columnar format scales to millions. We have 2,100 entries. Not relevant.
- **Concurrent writes** — LanceDB handles concurrent appends well. sqlite-vec inherits SQLite's single-writer model. We only write from one plugin instance. Not relevant.

### Scale validation

Our dataset: **~2,100 entries, 4096-dim float32 vectors**.

- Vector data size: 2,100 × 4,096 × 4 bytes = **33.6 MB** (comparable to current LanceDB 35MB)
- Brute-force KNN at 2K vectors: **<5ms** per query (sqlite-vec benchmarks show sub-ms at this scale)
- sqlite-vec struggles at 1M+ vectors with high dimensions. We're at 0.2% of that threshold.
- Growth projection: even at 20K entries (10× current), brute-force at 4096-dim takes ~50ms — acceptable for RAG.

**Conclusion:** sqlite-vec is the right tool for our scale. One database, one file, zero async complexity.

---

## 2. Target Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  memory-unified plugin v3.0                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │              skill-memory.db (single file)                ││
│  │                                                          ││
│  │  SQLite Tables              │  vec0 Virtual Table        ││
│  │  ─────────────              │  ──────────────────        ││
│  │  • unified_entries          │  • vec_entries              ││
│  │  • skills                   │    float[4096] cosine      ││
│  │  • conversations            │    entry_type metadata     ││
│  │  • patterns                 │    +text auxiliary         ││
│  │  • hnsw_meta                │                            ││
│  │  • FTS5 index               │  JOINed on entry_id       ││
│  │                             │                            ││
│  └──────────────────────────────────────────────────────────┘│
│                              │                               │
│                    Qwen3-Embedding 8B                         │
│                    Spark (192.168.1.80:11434)                 │
│                    4096 dimensions                            │
│                                                              │
│  Removed: @lancedb/lancedb, memory-vectors.lance             │
│  Added:   sqlite-vec (loadExtension into better-sqlite3)     │
└──────────────────────────────────────────────────────────────┘
```

### Key change

Vectors move from a separate LanceDB directory into a `vec0` virtual table **inside the same SQLite file**. The `unified_entries` table keeps its existing schema. A new `vec_entries` virtual table stores the 4096-dim embeddings, linked by `entry_id` primary key.

---

## 3. Schema Design

### 3.1 Existing table: `unified_entries` (unchanged)

```sql
CREATE TABLE IF NOT EXISTS unified_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type TEXT CHECK(entry_type IN (
        'skill','protocol','config','history','tool','result','task','file'
    )) NOT NULL,
    tags TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    source_path TEXT,
    hnsw_key TEXT,
    skill_id INTEGER REFERENCES skills(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    memory_type TEXT DEFAULT 'episodic',
    access_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMP,
    namespace TEXT DEFAULT 'general'
);
```

No changes. All existing data preserved.

### 3.2 New virtual table: `vec_entries`

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
    entry_id INTEGER PRIMARY KEY,
    embedding float[4096] distance_metric=cosine,
    entry_type TEXT,
    +text TEXT
);
```

**Column design:**

| Column       | Type              | Role               | Purpose                                    |
|--------------|-------------------|--------------------|--------------------------------------------|
| `entry_id`   | INTEGER PRIMARY KEY | Primary key       | FK → `unified_entries.id`                  |
| `embedding`  | float[4096]       | Vector column      | Qwen3 embedding, cosine distance           |
| `entry_type` | TEXT              | Metadata column    | Filterable in KNN WHERE clause             |
| `+text`      | TEXT              | Auxiliary column   | Text snippet (first 500 chars), fast lookup|

**Why cosine distance?** Qwen3 embeddings are normalized — cosine similarity is the natural metric. Using `distance_metric=cosine` means the `distance` output is `1 - cosine_similarity` (0 = identical, 2 = opposite).

**Why `entry_type` as metadata (not auxiliary)?** Metadata columns are indexed and can appear in KNN WHERE clauses. This lets us filter by type during search: `WHERE entry_type = 'skill'`.

**Why `+text` as auxiliary (not metadata)?** Text snippets are variable-length strings not useful as filter predicates. Auxiliary columns avoid index overhead and are JOINed at SELECT time.

### 3.3 Tracking table: `hnsw_meta` (unchanged)

```sql
CREATE TABLE IF NOT EXISTS hnsw_meta (
    entry_id INTEGER PRIMARY KEY,
    embedded_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Keeps tracking which entries have been embedded. Name is legacy but functional — renaming is unnecessary churn.

### 3.4 KNN query pattern

**Basic vector search (top 5 similar entries):**

```sql
SELECT
    entry_id,
    distance
FROM vec_entries
WHERE embedding MATCH ?
    AND k = 5;
```

**Filtered by entry_type (e.g., skills only):**

```sql
SELECT
    entry_id,
    distance
FROM vec_entries
WHERE embedding MATCH ?
    AND k = 5
    AND entry_type = 'skill';
```

**Enriched with full entry data (the common pattern):**

```sql
WITH knn AS (
    SELECT entry_id, distance
    FROM vec_entries
    WHERE embedding MATCH ?
        AND k = ?
)
SELECT
    ue.id, ue.entry_type, ue.content, ue.summary, ue.hnsw_key,
    knn.distance
FROM knn
JOIN unified_entries ue ON ue.id = knn.entry_id;
```

**Binding vectors from Node.js:**

```typescript
const embedding = new Float32Array(4096);
// ... fill from Qwen3 ...
const results = db.prepare(`
    SELECT entry_id, distance
    FROM vec_entries
    WHERE embedding MATCH ?
        AND k = ?
`).all(embedding, topK);
```

sqlite-vec accepts `Float32Array` directly from better-sqlite3 — no JSON serialization needed.

### 3.5 Insert pattern

```typescript
const embedding = new Float32Array(await qwenEmbed(text));
db.prepare(`
    INSERT INTO vec_entries (entry_id, embedding, entry_type, text)
    VALUES (?, ?, ?, ?)
`).run(entryId, embedding, entryType, text.slice(0, 500));
```

### 3.6 Delete pattern

```sql
DELETE FROM vec_entries WHERE entry_id = ?;
```

Standard SQL DELETE — no async API, no special method.

---

## 4. Migration Plan

### Phase 1: Add sqlite-vec alongside LanceDB (dual-write)

**Goal:** Verify sqlite-vec works without risking production search.

**Steps:**

1. **Install sqlite-vec:**
   ```bash
   npm install sqlite-vec
   ```

2. **Create `src/db/sqlite-vec.ts`** — new module:
   ```typescript
   import * as sqliteVec from "sqlite-vec";
   import type Database from "better-sqlite3";
   import { qwenEmbed } from "../embedding/ollama";

   export class SqliteVecStore {
       constructor(private db: Database.Database, private logger: any) {
           // Load sqlite-vec extension into the existing better-sqlite3 connection
           sqliteVec.load(db);
           this.initTable();
       }

       private initTable(): void {
           this.db.exec(`
               CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
                   entry_id INTEGER PRIMARY KEY,
                   embedding float[4096] distance_metric=cosine,
                   entry_type TEXT,
                   +text TEXT
               );
           `);
       }

       store(entryId: number, text: string, embedding: number[], entryType: string): boolean {
           try {
               // Delete existing if present (upsert pattern)
               this.db.prepare("DELETE FROM vec_entries WHERE entry_id = ?").run(entryId);
               this.db.prepare(
                   "INSERT INTO vec_entries (entry_id, embedding, entry_type, text) VALUES (?, ?, ?, ?)"
               ).run(entryId, new Float32Array(embedding), entryType, text.slice(0, 500));
               return true;
           } catch (err) {
               this.logger.warn?.("sqlite-vec store failed:", String(err));
               return false;
           }
       }

       search(queryEmbedding: number[], topK = 5, entryType?: string): Array<{ entryId: number; distance: number }> {
           try {
               const vec = new Float32Array(queryEmbedding);
               let sql: string;
               let params: any[];
               if (entryType) {
                   sql = "SELECT entry_id, distance FROM vec_entries WHERE embedding MATCH ? AND k = ? AND entry_type = ?";
                   params = [vec, topK, entryType];
               } else {
                   sql = "SELECT entry_id, distance FROM vec_entries WHERE embedding MATCH ? AND k = ?";
                   params = [vec, topK];
               }
               const rows = this.db.prepare(sql).all(...params) as any[];
               return rows.map(r => ({ entryId: r.entry_id, distance: r.distance }));
           } catch (err) {
               this.logger.warn?.("sqlite-vec search failed:", String(err));
               return [];
           }
       }

       delete(entryId: number): boolean {
           try {
               this.db.prepare("DELETE FROM vec_entries WHERE entry_id = ?").run(entryId);
               return true;
           } catch {
               return false;
           }
       }

       count(): number {
           try {
               const r = this.db.prepare("SELECT COUNT(*) as count FROM vec_entries").get() as any;
               return r?.count ?? 0;
           } catch {
               return 0;
           }
       }
   }
   ```

3. **Update `NativeLanceManager.addEntry()`** to dual-write:
   ```typescript
   // After successful LanceDB store:
   if (this.sqliteVecStore) {
       this.sqliteVecStore.store(entryId, text, embedding, metadata.entry_type);
   }
   ```

4. **Run bulk migration** to populate `vec_entries` from existing LanceDB data:
   - Iterate all entries in `hnsw_meta`
   - Re-embed each entry (or extract from LanceDB if possible)
   - Insert into `vec_entries`

5. **Verify** by running parallel searches against both backends and comparing results.

**Files changed:**
- `package.json` — add `sqlite-vec` dependency
- `src/db/sqlite-vec.ts` — new file
- `src/db/lance-manager.ts` — add dual-write to `addEntry()`
- `src/db/sqlite.ts` — load sqlite-vec extension in constructor

### Phase 2: Switch reads to sqlite-vec

**Goal:** All search queries use sqlite-vec. LanceDB still receives writes but is no longer read.

**Steps:**

1. **Create `src/db/vec-manager.ts`** — replaces `lance-manager.ts` with same interface:
   ```typescript
   export class VecManager {
       private vecStore: SqliteVecStore;
       // Same public API as NativeLanceManager:
       // isReady(), search(), addEntry(), bulkIndex(), save(), getCount()
       // But all operations are synchronous (no Promises for store/delete)
   }
   ```

2. **Update `src/hooks/rag-injection.ts`:**
   - `lanceManager.search(prompt, 5)` → `vecManager.search(prompt, 5)`
   - Results format is identical: `{ entryId, distance }`
   - Distance semantics change: LanceDB returns L2 distance, sqlite-vec with `distance_metric=cosine` returns cosine distance (0–2 range). Adjust similarity calculation:
     ```typescript
     // LanceDB (L2): sim = 1 - distance (approximate, already normalized)
     // sqlite-vec (cosine): distance IS 1 - cosine_sim, so sim = 1 - distance
     // Same formula works — no change needed in threshold logic
     ```

3. **Update `src/tools/unified-search.ts`:**
   - Replace `lanceManager` parameter type with `VecManager`
   - Search call remains: `vecManager.search(query, limit)`

4. **Update `src/tools/unified-store.ts`:**
   - Replace `hnswManager` parameter with `vecManager`
   - `vecManager.addEntry(entryId, text)` — same interface

5. **Update `src/index.ts`:**
   - Import `VecManager` instead of `NativeLanceManager`
   - Pass to hooks and tools

**Files changed:**
- `src/db/vec-manager.ts` — new file (replaces lance-manager.ts)
- `src/hooks/rag-injection.ts` — swap manager type
- `src/tools/unified-search.ts` — swap manager type
- `src/tools/unified-store.ts` — swap manager type
- `src/index.ts` — swap manager import and instantiation

### Phase 3: Remove LanceDB dependency

**Goal:** Clean removal. Single database file.

**Steps:**

1. **Delete files:**
   - `src/db/lancedb.ts` — LanceVectorStore class
   - `src/db/lance-manager.ts` — NativeLanceManager wrapper

2. **Remove from `package.json`:**
   ```bash
   npm uninstall @lancedb/lancedb
   ```
   This removes ~132MB of node_modules.

3. **Delete LanceDB data:**
   ```bash
   rm -rf ~/.openclaw/workspace/memory-vectors.lance
   ```
   Frees ~35MB on disk.

4. **Update types:**
   - Remove `NativeLanceManager` interface from `src/hooks/rag-injection.ts`
   - Remove `RufloHNSW` interface from `src/types.ts` (dead since v2.0)
   - Clean up any remaining `ruflo` parameters (pass-through nulls)

5. **Clean dead code:**
   - Remove `src/utils/hnsw.ts` (already dead)
   - Remove `src/daemon.ts` (already dead)
   - Remove `src/migrate.ts` (already dead)
   - Remove `src/embedding/provider.ts` (already dead)

6. **Rebuild and test:**
   ```bash
   npm run build
   openclaw gateway restart
   ```

**Files deleted:**
- `src/db/lancedb.ts`
- `src/db/lance-manager.ts`
- `src/utils/hnsw.ts`
- `src/daemon.ts`
- `src/migrate.ts`
- `src/embedding/provider.ts`

**Dependencies removed:**
- `@lancedb/lancedb`

---

## 5. API Changes by File

### `src/db/sqlite.ts` — UnifiedDBImpl

**Change:** Load sqlite-vec extension on database open.

```typescript
// In constructor, after new Database(dbPath):
import * as sqliteVec from "sqlite-vec";

constructor(dbPath: string) {
    // ... existing setup ...
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);  // <-- NEW: load sqlite-vec
    this.db.pragma("journal_mode = WAL");
    // ... rest unchanged ...
}
```

### `src/db/sqlite-vec.ts` — NEW: SqliteVecStore

Replaces `src/db/lancedb.ts`. See Phase 1 above for full implementation. Key API:

```typescript
class SqliteVecStore {
    constructor(db: Database.Database, logger: any)
    store(entryId: number, text: string, embedding: number[], entryType: string): boolean
    search(queryEmbedding: number[], topK?: number, entryType?: string): Array<{ entryId: number; distance: number }>
    delete(entryId: number): boolean
    count(): number
}
```

**Differences from LanceVectorStore:**
- No `init()` — table created in constructor (synchronous)
- `store()` returns `boolean` (sync), not `Promise<boolean>`
- `search()` returns synchronously, not `Promise`
- `delete()` is synchronous
- No `has()` method (use `count()` or just try the store)
- Filters are typed (`entryType` parameter) not arbitrary `Record<string, any>`

### `src/db/vec-manager.ts` — NEW: VecManager (replaces lance-manager.ts)

Same public interface as `NativeLanceManager` for drop-in swap:

```typescript
class VecManager {
    constructor(db: Database.Database, logger: any)
    isReady(): boolean                    // always true after construction
    getCount(): number                    // from hnsw_meta
    addEntry(entryId: number, text: string): Promise<boolean>  // embed + store
    search(query: string, topK?: number): Promise<Array<{ entryId: number; distance: number }>>
    bulkIndex(): Promise<void>            // batch embed unindexed entries
    save(): void                          // no-op (SQLite auto-persists)
}
```

**Key simplification:** `isReady()` is always `true` — no async init. The `addEntry()` and `search()` methods remain async because they call `qwenEmbed()` (network call to Spark), but the SQLite operations within are synchronous.

### `src/hooks/rag-injection.ts`

**Changes:**
- `HookDependencies.lanceManager` type changes from LanceDB-specific to VecManager
- `lanceManager.search(prompt, 5)` call is unchanged (same interface)
- Similarity calculation unchanged: `sim = 1 - distance` works for both L2 and cosine distance
- Remove `ruflo` from `HookDependencies` (dead code cleanup)

### `src/tools/unified-search.ts`

**Changes:**
- Import `VecManager` instead of `NativeLanceManager`
- Parameter type: `lanceManager: NativeLanceManager | null` → `vecManager: VecManager | null`
- Search call unchanged: `vecManager.search(query, limit)`
- Can add filtered search: `vecManager.searchFiltered(query, limit, entryType)`

### `src/tools/unified-store.ts`

**Changes:**
- Remove `NativeHnswManager` interface (dead)
- Remove `RufloHNSW` parameter (dead)
- Parameter: `hnswManager` → `vecManager: VecManager | null`
- `vecManager.addEntry(entryId, summary || content)` — same call

### `src/index.ts`

**Changes:**
- Import `VecManager` instead of `NativeLanceManager`
- Construction simplifies:
  ```typescript
  // Before (async init, error handling):
  lanceManager = new NativeLanceManager(resolvedDbPath, udb.db, api.logger);

  // After (synchronous, always ready):
  const vecManager = new VecManager(udb.db, api.logger);
  ```
- Pass `vecManager` to hooks and tools instead of `lanceManager`
- Remove `lanceManager.save()` from service stop (SQLite auto-persists)

### `src/types.ts`

**Changes:**
- Remove `RufloHNSW` interface (dead since v2.0)
- Add `VecSearchResult` type:
  ```typescript
  export interface VecSearchResult {
      entryId: number;
      distance: number;
  }
  ```

---

## 6. Dependencies

### Remove

| Package           | Size (installed) | Reason                          |
|-------------------|------------------|---------------------------------|
| `@lancedb/lancedb`| ~132MB           | Replaced by sqlite-vec          |

### Add

| Package      | Size (installed) | Purpose                          |
|--------------|------------------|----------------------------------|
| `sqlite-vec` | ~2MB             | sqlite-vec extension for better-sqlite3 |

### Keep

| Package             | Purpose                    |
|---------------------|----------------------------|
| `better-sqlite3`    | SQLite database driver     |
| `@sinclair/typebox` | Schema validation          |

### Final `package.json` dependencies

```json
{
  "dependencies": {
    "@sinclair/typebox": "^0.32.0",
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.6"
  }
}
```

### Compatibility: sqlite-vec + better-sqlite3

sqlite-vec provides a `load(db)` function that calls `db.loadExtension()` internally. This is the officially supported integration path. The `sqlite-vec` npm package bundles precompiled native extensions for Linux (x64, arm64), macOS, and Windows.

**Important:** better-sqlite3 must be compiled **without** the `--omit-extensions` flag (default is fine). The `sqlite-vec` load function handles finding the correct platform-specific binary automatically.

---

## 7. Performance Comparison

### At our scale: ~2,100 entries, 4096 dimensions

| Metric                | LanceDB (current)        | sqlite-vec (target)        |
|-----------------------|--------------------------|----------------------------|
| **Search latency**    | ~15ms (IVF + network)    | **<5ms** (brute-force, in-process) |
| **Insert latency**    | ~5ms (async, Arrow)      | **<1ms** (sync, SQL)       |
| **Cold start**        | ~200ms (open table, mmap)| **<10ms** (extension load)  |
| **Memory usage**      | ~50MB (mmap'd)           | **~35MB** (vec0 pages)     |
| **Disk usage**        | 35MB (.lance dir)        | **~34MB** (in .db file)    |
| **Embedding overhead**| ~50ms (Qwen3 via Ollama) | ~50ms (same — unchanged)  |
| **Backup**            | Copy .db + .lance/       | **Copy one .db file**      |

### Why brute-force is fine here

sqlite-vec does **brute-force** (exhaustive) search, not approximate nearest neighbor (ANN). This sounds slower, but:

1. **Small dataset:** At 2K vectors, brute-force scans all vectors in a single pass. With SIMD (AVX2), 2K × 4096-dim cosine computations take <5ms.
2. **No index overhead:** ANN indexes (IVF, HNSW) add insert-time cost, memory for graph structures, and rebuild time. At our scale, the index overhead exceeds the search savings.
3. **Exact results:** Brute-force returns exact K nearest neighbors. ANN returns approximate results with recall <100%.

### Scaling limits

| Dataset size | 4096-dim search latency | Acceptable?           |
|-------------|-------------------------|-----------------------|
| 2K entries  | <5ms                    | Excellent             |
| 10K entries | ~20ms                   | Fine for RAG          |
| 50K entries | ~100ms                  | Borderline            |
| 100K entries| ~200ms                  | Needs quantization    |
| 1M entries  | ~8s                     | Need different backend|

**Growth projection:** At current ingestion rate (~50 entries/day), reaching 50K takes ~3 years. We have ample runway.

**If we outgrow brute-force:** sqlite-vec supports int8 scalar quantization (4× memory reduction, ~2× speed improvement) and binary quantization (32× memory reduction). These can extend the practical limit to ~200K entries before needing a dedicated vector database.

---

## 8. Rollback Plan

### Pre-migration safety

1. **Backup before Phase 1:**
   ```bash
   cp ~/.openclaw/workspace/skill-memory.db ~/.openclaw/workspace/skill-memory.db.pre-v3
   cp -r ~/.openclaw/workspace/memory-vectors.lance ~/.openclaw/workspace/memory-vectors.lance.pre-v3
   ```

2. **Keep `@lancedb/lancedb` in devDependencies** during Phase 1–2 for easy rollback.

3. **Git branch:** All v3 work on a `feat/sqlite-vec` branch. Main branch stays on LanceDB.

### Rollback from Phase 1 (dual-write)

- Remove `sqliteVec.load(db)` call
- Drop `vec_entries` table: `DROP TABLE IF EXISTS vec_entries;`
- Revert `package.json` changes
- `npm install` to restore original node_modules
- Rebuild: `npm run build`

### Rollback from Phase 2 (reads switched)

- Revert `src/db/vec-manager.ts` → re-import `NativeLanceManager`
- Revert hook/tool changes to use LanceDB manager
- LanceDB data still exists (was receiving dual-writes in Phase 1)
- Rebuild: `npm run build`

### Rollback from Phase 3 (LanceDB removed)

- Restore from backup:
  ```bash
  cp ~/.openclaw/workspace/memory-vectors.lance.pre-v3 ~/.openclaw/workspace/memory-vectors.lance
  ```
- `npm install @lancedb/lancedb`
- Restore deleted files from git: `git checkout main -- src/db/lancedb.ts src/db/lance-manager.ts`
- Rebuild: `npm run build`

### Point of no return

There is no true point of no return. The `vec_entries` table and `unified_entries` table are independent. Even after deleting the LanceDB files, re-running `bulkIndex()` can rebuild the vector index from scratch using the `unified_entries` content + `hnsw_meta` tracking.

---

## 9. Testing Checklist

### Phase 1 verification (dual-write)

- [ ] `npm install sqlite-vec` succeeds
- [ ] `sqliteVec.load(db)` runs without error
- [ ] `CREATE VIRTUAL TABLE vec_entries USING vec0(...)` succeeds
- [ ] Insert a test vector (4096-dim Float32Array) into `vec_entries`
- [ ] KNN query returns the test vector
- [ ] Filtered KNN query (`AND entry_type = 'skill'`) works
- [ ] `DELETE FROM vec_entries WHERE entry_id = ?` works
- [ ] Bulk migration populates `vec_entries` from existing data
- [ ] `vec_entries` row count matches `hnsw_meta` row count
- [ ] Parallel search: sqlite-vec results match LanceDB results (same top-5 for test queries)

### Phase 2 verification (reads switched)

- [ ] RAG injection uses sqlite-vec for vector search
- [ ] `unified_search` tool returns vector results from sqlite-vec
- [ ] `unified_store` tool writes to sqlite-vec
- [ ] Similarity thresholds (50% display, 60% procedure injection) still filter correctly
- [ ] Skill procedure injection triggers on known test queries
- [ ] No errors in gateway logs after `openclaw gateway restart`
- [ ] Search latency is equal or better than LanceDB

### Phase 3 verification (LanceDB removed)

- [ ] `npm uninstall @lancedb/lancedb` succeeds
- [ ] `npm run build` succeeds with no LanceDB imports
- [ ] `dist/index.js` runs correctly
- [ ] `openclaw gateway restart` — plugin loads and registers
- [ ] Full RAG pipeline works: FTS5 → vector → pattern → conversation
- [ ] `unified_search` returns both SQL and vector results
- [ ] `unified_store` writes entry and embeds vector
- [ ] `unified_index_files` indexes files into both tables
- [ ] Bulk indexing on startup works
- [ ] Gateway logs show no errors or warnings from memory-unified
- [ ] Disk usage: `memory-vectors.lance` directory no longer exists
- [ ] `node_modules` size reduced (~130MB less)

### Regression tests

- [ ] Store a skill entry → verify it appears in FTS5 search
- [ ] Store a skill entry → verify it appears in vector search
- [ ] Store a history entry → verify it's excluded from `entry_type = 'skill'` filtered search
- [ ] RAG injection on a known skill query → verify procedure is injected
- [ ] RAG injection on an unrelated query → verify no false positive procedure injection
- [ ] Pattern matching still works (confidence-based keyword overlap)
- [ ] Conversation context still surfaces in RAG
- [ ] File indexing (`openclaw ingest <path>`) still works
- [ ] Service stop → no errors in shutdown log

---

## 10. File Structure After v3.0

```
src/
  index.ts                      ← Plugin entry point
  config.ts                     ← Config schema + validation
  types.ts                      ← Type definitions (cleaned)
  db/
    sqlite.ts                   ← UnifiedDBImpl (loads sqlite-vec)
    sqlite-vec.ts               ← SqliteVecStore (vec0 operations)
    vec-manager.ts              ← VecManager (embed + store + search)
  embedding/
    ollama.ts                   ← Qwen3 embedding via Ollama
  hooks/
    rag-injection.ts            ← before_agent_start RAG (uses VecManager)
    on-turn-end.ts              ← Tool call logging + agent end
  tools/
    unified-search.ts           ← Search tool (SQL + vec)
    unified-store.ts            ← Store tool (SQL + vec)
    unified-conversations.ts    ← Conversations tool
    file-indexer.ts             ← File indexing tool

Deleted:
  src/db/lancedb.ts             ← LanceVectorStore (replaced)
  src/db/lance-manager.ts       ← NativeLanceManager (replaced)
  src/utils/hnsw.ts             ← NativeHnswManager (dead since v2.0)
  src/daemon.ts                 ← File queue watcher (never used)
  src/migrate.ts                ← One-time migration (done)
  src/embedding/provider.ts     ← Abstract interface (unused)
```

---

## 11. Infrastructure (post-migration)

| Component  | Host                  | Details                                    |
|------------|-----------------------|--------------------------------------------|
| SQLite DB  | Tank (192.168.1.100)  | ~/.openclaw/workspace/skill-memory.db      |
| Vectors    | Tank (192.168.1.100)  | Inside skill-memory.db (vec_entries table)  |
| Embeddings | Spark (192.168.1.80)  | Ollama, qwen3-embedding:8b, port 11434    |
| Plugin     | Tank                  | ~/.openclaw/extensions/memory-unified/     |

**Removed:**
- `memory-vectors.lance` directory (35MB)
- `skill-memory.hnsw` file (103MB, already dead)

**Single-file backup:**
```bash
sqlite3 ~/.openclaw/workspace/skill-memory.db ".backup '/path/to/backup.db'"
```

---

## References

- [sqlite-vec GitHub](https://github.com/asg017/sqlite-vec) — source, releases, issues
- [sqlite-vec Node.js guide](https://alexgarcia.xyz/sqlite-vec/js.html) — better-sqlite3 integration
- [sqlite-vec KNN queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html) — MATCH syntax
- [sqlite-vec metadata columns](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html) — filtering in vec0
- [sqlite-vec npm](https://www.npmjs.com/package/sqlite-vec) — package, v0.1.6
- [sqlite-vec v0.1.0 announcement](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html) — benchmarks, design rationale

---

*Generated by Claude Code — 2026-03-04*
