# Memory Management Audit — memory-unified v2.0

**Date:** 2026-04-06
**Auditor:** Software Architect Agent (Claude Opus 4.6)
**Branch:** `fix/rerank-threshold` (based on `main`)
**Scope:** Full codebase review against upstream OpenClaw 2026.3.13 capabilities + general quality audit

---

## Priority Summary Table

| # | Item | Priority | Effort | Category |
|---|------|----------|--------|----------|
| 1 | No graceful shutdown / flush protection | **HIGH** | S | Data Safety |
| 2 | N+1 query in vector search post-filtering | **HIGH** | S | Performance |
| 3 | Entity backfill leaks Postgres internals through `DatabasePort` | **HIGH** | M | Abstraction Violation |
| 4 | No multimodal content handling | **MEDIUM** | L | Feature Gap |
| 5 | Single embedding provider — no abstraction layer | **MEDIUM** | M | Feature Gap |
| 6 | No post-compaction session reindexing | **MEDIUM** | M | Feature Gap |
| 7 | No vector collection integrity checks | **MEDIUM** | S | Data Safety |
| 8 | Unbounded `getFactsForDecay()` query | **MEDIUM** | S | Performance |
| 9 | Fire-and-forget extraction with no error recovery | **MEDIUM** | M | Reliability |
| 10 | `schema.sql` drift from runtime DDL | **MEDIUM** | S | Maintenance |
| 11 | `globalThis` state pollution | **MEDIUM** | M | Correctness |
| 12 | Dead code: `VectorManager` class in `vector-manager.ts` | **LOW** | S | Dead Code |
| 13 | Conversation merge heuristic fragility | **LOW** | S | Correctness |
| 14 | Duplicated LLM call boilerplate | **LOW** | S | Code Quality |
| 15 | Missing index on `memory_facts.tier` | **LOW** | S | Performance |
| 16 | Skill embedding cache is never invalidated | **LOW** | S | Correctness |
| 17 | `memory_revisions` CHECK constraint drift | **LOW** | S | Schema |

---

## 1. No Graceful Shutdown / Flush Protection

**Priority:** HIGH | **Effort:** S

**Current state:**
The service `stop()` handler calls `vectorManager.save()` (a no-op) and `port.close()`. There is no protection for:
- In-flight `extractFacts()` or `consolidateFact()` calls during shutdown (fire-and-forget promises in `agent_end` hook)
- Bulk indexing (`bulkIndex()`) running in background on startup
- Entity backfill running asynchronously

If the process exits while any of these are mid-flight, partial writes can occur. The SQLite backend uses WAL mode (good), but the Postgres backend has no transaction guards around multi-step operations like `consolidateFact` (store fact + store revision + store embedding = 3 separate queries).

**Recommended change:**
1. Track active background promises in a `Set<Promise<void>>` on the plugin state.
2. In `stop()`, call `await Promise.allSettled([...activePromises])` with a 5-second timeout before closing the port.
3. For Postgres `consolidateFact`, wrap the store-fact + store-revision + store-embedding sequence in a single transaction via `BEGIN/COMMIT`.

**File:** `src/index.ts` (lines 491-496)

---

## 2. N+1 Query in Vector Search Post-Filtering

**Priority:** HIGH | **Effort:** S

**Current state:**
`PortVectorManager.search()` (lines 84-106 in `src/index.ts`) iterates over vector results and calls `port.queryEntries({ ids: [r.entryId] })` individually for each result to check `entry_type`. This is an N+1 pattern where N = `topK + 10`.

Similarly, `VectorManager.search()` in `src/db/vector-manager.ts` (lines 86-98) does individual `SELECT ... WHERE id = ?` queries per result for metadata enrichment.

**Recommended change:**
Batch the ID lookup: collect all `entryId` values, do a single `queryEntries({ ids: allIds })`, then filter in memory.

```typescript
const allIds = results.map(r => r.entryId);
const entries = await port.queryEntries({ ids: allIds });
const entryMap = new Map(entries.map(e => [e.id, e]));
// Then filter using entryMap.get(r.entryId)
```

**Files:**
- `src/index.ts` (lines 93-105)
- `src/db/vector-manager.ts` (lines 86-98)

---

## 3. Entity Backfill Leaks Postgres Internals Through DatabasePort

**Priority:** HIGH | **Effort:** M

**Current state:**
`src/entity/backfill.ts` accesses `(port as any).pool.query(...)` directly (lines 168, 179, 191, 196, 205, 217), bypassing the `DatabasePort` abstraction entirely. This:
- Crashes silently on the SQLite backend (returns empty `Set` via try/catch)
- Couples backfill logic to Postgres implementation details
- Violates the port/adapter pattern established by the codebase

**Recommended change:**
Add these methods to `DatabasePort`:
- `getFactIdsWithMentions(): Promise<Set<number>>`
- `getEntryIdsWithMentions(): Promise<Set<number>>`
- `getEntityCount(): Promise<number>`
- `getRelationCount(): Promise<number>`

Implement them in `PostgresPort` (real queries) and `SqlitePort` (stubs returning empty sets / 0, since entities are Postgres-only currently).

**File:** `src/entity/backfill.ts`

---

## 4. No Multimodal Content Handling

**Priority:** MEDIUM | **Effort:** L

**Current state:**
The plugin processes only text content. The RAG injection hook strips audio metadata (`[Audio]`, `Transcript:`) and WhatsApp media tags (`<media:...>`) but does not:
- Store MIME type or content type metadata on entries
- Handle binary/blob content (images, audio files)
- Integrate with the Whisper transcription endpoint (port 9000, documented in CLAUDE.md) for audio-to-text indexing
- Store or index image descriptions or OCR output

The `rag-injection.ts` hook (lines 84-91) extracts transcript text from audio messages, which is a partial solution, but the raw audio reference and any image attachments are discarded entirely.

**Recommended change:**
1. Add `content_type` (TEXT, default) and `media_url` (nullable) columns to `unified_entries`.
2. For audio messages: call Whisper endpoint to get transcript, store both transcript (as `content`) and original media reference (as `media_url`).
3. For images: if an image description/caption is available from the gateway, index it as an entry with `content_type = 'image'`.
4. Add a `multimodal` config flag to enable/disable this behavior.

**Files:** `src/hooks/rag-injection.ts`, `src/db/port.ts`, `schema.sql`

---

## 5. Single Embedding Provider — No Abstraction Layer

**Priority:** MEDIUM | **Effort:** M

**Current state:**
`src/embedding/nemotron.ts` is a single concrete implementation hardcoded to the OpenAI-compatible `/v1/embeddings` API. It works for Qwen3, Nemotron, and any OpenAI-compatible endpoint, but:
- There is no `EmbeddingProvider` interface or strategy pattern
- Gemini embeddings (which use a different API shape: `models/{model}:embedContent`) cannot be plugged in without modifying this file
- The `embed()` function is imported directly throughout the codebase (15+ import sites)

**Recommended change:**
1. Define an `EmbeddingProvider` interface: `{ embed(text: string, type: "query"|"passage"): Promise<number[] | null>; embedBatch(texts: string[]): Promise<(number[]|null)[]>; readonly dim: number; }`
2. Create `OpenAIEmbeddingProvider` (current code), `GeminiEmbeddingProvider` (new), and optionally `OllamaEmbeddingProvider`.
3. Instantiate the provider based on config (`embeddingProvider: "openai" | "gemini" | "ollama"`) and pass it via dependency injection rather than direct import.

This is a medium-effort refactor because `embed()` and `EMBED_DIM` are imported in 8+ files.

**Files:** `src/embedding/nemotron.ts`, `src/config.ts`, all consumers

---

## 6. No Post-Compaction Session Reindexing

**Priority:** MEDIUM | **Effort:** M

**Current state:**
The `before_compaction` hook (`src/hooks/on-turn-end.ts`, lines 366-410) extracts lessons/facts from the conversation being compacted, which is good. However, it does NOT:
- Generate a summary of the compacted session
- Reindex the compacted summary into the vector store
- Update the conversation thread with a compaction marker
- Store the compaction event in the topic timeline

After compaction, the original messages are gone from context. The extracted lessons are stored as `memory_facts`, but the broader narrative context of what happened in the session is lost to retrieval.

**Recommended change:**
1. In the `before_compaction` hook, after extracting lessons, generate a session summary (via LLM or simple concatenation of message summaries).
2. Store the summary as a `unified_entries` record with `entry_type = 'history'` and a tag like `compacted-session`.
3. Embed the summary into the vector store so it is retrievable by future RAG queries.
4. Optionally record a topic event: `port.recordTopicEvent(slug, 'compaction', null, summary, agentId)`.

**File:** `src/hooks/on-turn-end.ts` (lines 366-410)

---

## 7. No Vector Collection Integrity Checks

**Priority:** MEDIUM | **Effort:** S

**Current state:**
There are no safeguards against corrupted or incomplete vector collections:
- `sqlite-vec` virtual tables can become corrupt if the process crashes mid-write
- `hnsw_meta` tracking table can desync from `vec_entries` — the code checks `hnsw_meta` to decide if an entry is embedded, but does not verify the vector actually exists in `vec_entries`
- Postgres `pgvector` embeddings could have NULL or wrong-dimension vectors with no validation
- The `bulkIndex()` and `backfillFactEmbeddings()` functions have no checksum or row-count verification after completion

**Recommended change:**
1. Add a startup health check: compare `COUNT(*)` of `hnsw_meta` vs `vec_entries` (SQLite) or embedding column non-null count (Postgres). Log a warning if they differ by >5%.
2. Add dimension validation in `storeEntryEmbedding` / `storeFactEmbedding`: reject embeddings where `length !== embeddingDim`.
3. In `runDataCleanup()`, add a step to delete `hnsw_meta` rows where the corresponding `vec_entries` row is missing (orphan cleanup).

**Files:**
- `src/db/sqlite-port.ts` (lines 881-956)
- `src/db/sqlite-vec.ts` (line 30-37)

---

## 8. Unbounded `getFactsForDecay()` Query

**Priority:** MEDIUM | **Effort:** S

**Current state:**
`SqlitePort.getFactsForDecay()` (line 367-378 in `sqlite-port.ts`) fetches ALL active facts with confidence > 0.3, with no LIMIT clause. Called from `ebbinghausDecay()` and `autoTiering()` on every startup.

**Recommended change:**
1. Add a `LIMIT 1000` with `ORDER BY last_accessed_at ASC NULLS FIRST` to prioritize facts most likely to need decay.
2. Split `autoTiering()` to use a separate, targeted query: only fetch hot facts (for demotion check) and warm facts with high access count (for promotion check).

**File:** `src/db/sqlite-port.ts` (lines 367-378)

---

## 9. Fire-and-Forget Extraction With No Error Recovery

**Priority:** MEDIUM | **Effort:** M

**Current state:**
In the `agent_end` hook (`src/hooks/on-turn-end.ts`, lines 318-339), fact extraction and entity extraction are fire-and-forget. If the extraction LLM is temporarily down, the conversation text is lost forever — there is no retry queue or dead-letter mechanism.

**Recommended change:**
1. On extraction failure, store the conversation text in a `pending_extractions` table with a retry counter.
2. On startup (or periodically), process pending extractions.
3. Cap retries at 3 attempts, then archive with an error reason.

**Files:** `src/hooks/on-turn-end.ts`, `src/memory-bank/extractor.ts`

---

## 10. `schema.sql` Drift From Runtime DDL

**Priority:** MEDIUM | **Effort:** S

**Current state:**
The `schema.sql` file is out of date compared to the actual DDL executed at runtime:
- Missing tables: `conversations`, `conversation_messages`, `patterns`, `pattern_history`, `feedback`, `memory_facts_vec`, `unified_fts`
- Missing entry types in CHECK constraints
- Missing columns added by migrations: `status`, `scope`, `temporal_type`, `repeated_count`, `tier`, `strength` on `memory_facts`

**Recommended change:**
Regenerate `schema.sql` from the current runtime DDL in `sqlite.ts`, or remove it and document that tables are created programmatically.

**File:** `schema.sql`

---

## 11. `globalThis` State Pollution

**Priority:** MEDIUM | **Effort:** M

**Current state:**
The codebase writes to `globalThis` in multiple places:
- `(globalThis as any).__openclawAgentId`
- `(globalThis as any).__openclawSessionKey`
- `(globalThis as any).__openclawDynamicToolPolicy`

This creates implicit shared mutable state that could conflict with other plugins and is not safe under concurrent agent invocations.

**Recommended change:**
Pass these values through a scoped context object (e.g., `MemoryState`) that is already threaded through the hooks. If upstream OpenClaw requires `globalThis` for dynamic tool policy, namespace the key (e.g., `__openclaw_memoryUnified_toolPolicy`).

**Files:** `src/hooks/rag-injection.ts` (lines 69-70, 312-316), `src/hooks/on-turn-end.ts` (lines 131, 351-356)

---

## 12. Dead Code: `VectorManager` Class

**Priority:** LOW | **Effort:** S

**Current state:**
`src/db/vector-manager.ts` contains a full `VectorManager` class (180 lines) that is NOT used anywhere in the active code. It was replaced by `PortVectorManager` in `src/index.ts`. The file is only imported for its `NativeLanceManager` type re-export.

**Recommended change:**
Delete the `VectorManager` class body. Keep only the type alias if needed for backward compatibility, or update hook interfaces to use `PortVectorManager` directly.

**File:** `src/db/vector-manager.ts`

---

## 13. Conversation Merge Heuristic Fragility

**Priority:** LOW | **Effort:** S

**Current state:**
Conversations are merged based on tag overlap >= 2 OR topic substring match (first 20 chars). The substring match is fragile — common prefixes like "memory" can cause unrelated conversations to merge.

**Recommended change:**
Replace substring heuristic with embedding similarity: embed the new topic, compare against recent conversation topics via cosine similarity with a threshold of 0.75+.

**File:** `src/hooks/on-turn-end.ts` (lines 240-259)

---

## 14. Duplicated LLM Call Boilerplate

**Priority:** LOW | **Effort:** S

**Current state:**
The pattern of "build headers for Anthropic vs OpenAI, call fetch, parse response" is duplicated in 5 files: `extractor.ts`, `consolidator.ts`, `on-turn-end.ts`, `entity/extractor.ts`, `unified-reflect.ts`.

**Recommended change:**
Extract a shared `callExtractionLLM(prompt, config, opts?)` utility.

---

## 15. Missing Index on `memory_facts.tier`

**Priority:** LOW | **Effort:** S

**Current state:**
`getHotFacts()` queries `WHERE status = 'active' AND tier = 'hot'`, but there is no index on the `tier` column.

**Recommended change:**
Add `CREATE INDEX IF NOT EXISTS idx_facts_tier ON memory_facts(tier);` to the migration block and Postgres schema.

**File:** `src/db/sqlite.ts`

---

## 16. Skill Embedding Cache Never Invalidated

**Priority:** LOW | **Effort:** S

**Current state:**
`src/embedding/nemotron.ts` maintains a module-level `skillEmbCache` that is loaded once and never refreshed. Also has a race condition on the `skillEmbLoading` flag.

**Recommended change:**
1. Add a TTL (e.g., 10 minutes) or a generation counter to the cache.
2. Use a `Promise` instead of a boolean flag to prevent concurrent loading.

**File:** `src/embedding/nemotron.ts` (lines 135-165)

---

## 17. `memory_revisions` CHECK Constraint Drift

**Priority:** LOW | **Effort:** S

**Current state:**
`schema.sql` defines `revision_type` CHECK constraint missing `contradicted`, `decay`, and `deleted` types that the runtime code writes.

**Recommended change:**
Update `schema.sql` to include all revision types: `('created','updated','merged','expired','manual_edit','contradicted','decay','deleted')`.

**File:** `schema.sql` (line 124)

---

## Additional Observations

### SQLite Backend: Entity Features Are Stubbed Out
The `SqlitePort` returns empty arrays / 0 / no-op for all entity operations. The entity graph strategy in RAG injection will always return empty results on SQLite. Consider adding a startup log warning when `backend = 'sqlite'` and entity features are requested.

### Hardcoded Seed Data
The topic registry seed data in `src/index.ts` (lines 209-226) contains project-specific names like "Dominika", "Higienistka", "Numerika Instagram". This should be moved to a config file or the config schema, not hardcoded in the plugin.

### PostgreSQL Port: Missing `RETURNING` Optimization
Several Postgres write operations do `INSERT` followed by a separate `SELECT` to get the inserted row's ID. Use `RETURNING id` instead.
