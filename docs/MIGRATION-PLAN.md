# Migration Plan: LanceDB → sqlite-vec → Huly Integration

*Created: 2026-03-04 | Author: Wiki + Opus 4.6 review*

## Current State

- **v2.2**: SQLite (structured) + LanceDB (vectors) — two separate stores
- **Phase 1 COMPLETE**: Dual-write to sqlite-vec alongside LanceDB (7/7 on Hermes)
- **Key fix**: sqlite-vec `vec0` requires `BigInt` for `INTEGER PRIMARY KEY` (commit `18f2dd2`)

## Phase 2: Read from sqlite-vec (this week)

**Goal:** Switch vector reads from LanceDB → sqlite-vec, keep LanceDB as fallback.

### Tasks
- [ ] Add `search()` call path through `SqliteVecStore` in `unified-search` tool
- [ ] Add config flag `vectorBackend: "sqlite-vec" | "lancedb" | "dual"` (default: `"dual"`)
- [ ] When `dual`: query both, merge results, deduplicate by entry_id
- [ ] When `sqlite-vec`: query sqlite-vec only, LanceDB not touched
- [ ] Benchmark: compare top-5 results quality between backends
- [ ] Deploy to Hermes for testing

### Acceptance Criteria
- `unified_search` returns identical or better results from sqlite-vec
- No regressions in RAG injection quality
- Latency ≤ LanceDB (expected: faster, since in-process)

## Phase 3: Remove LanceDB (next week)

**Goal:** Single-file architecture. Delete LanceDB dependency.

### Tasks
- [ ] Remove `vectordb` from `package.json`
- [ ] Remove `src/db/lance-manager.ts` and `src/db/lance-store.ts`
- [ ] Remove `.lance` directory handling
- [ ] Update `src/index.ts` — sqlite-vec becomes sole vector backend
- [ ] Update all hooks to use `SqliteVecStore` directly
- [ ] Migration script: for existing installs, bulk-copy LanceDB → sqlite-vec
- [ ] Update README, ARCHITECTURE docs

### Acceptance Criteria
- `npm install` no longer pulls `vectordb` (~130MB savings)
- Single `skill-memory.db` file contains everything
- All existing deployments (Wiki, Hermes) migrated without data loss

## Phase 4: Schema Extension for External Sync (week after)

**Goal:** Add columns for Huly/GitHub/external system integration.

### Schema Change
```sql
ALTER TABLE unified_entries ADD COLUMN external_id TEXT;
ALTER TABLE unified_entries ADD COLUMN external_source TEXT;  -- 'huly', 'github', etc.
ALTER TABLE unified_entries ADD COLUMN external_updated INTEGER;  -- unix timestamp
ALTER TABLE unified_entries ADD COLUMN sync_status TEXT DEFAULT 'local_only';
  -- values: 'synced', 'local_only', 'conflict', 'pending_push'

CREATE INDEX idx_unified_external ON unified_entries(external_source, external_id);
CREATE INDEX idx_unified_sync ON unified_entries(sync_status);
```

### Why Before Huly
- Idempotent upsert: `WHERE external_source = 'huly' AND external_id = ?`
- No duplicate creation on repeated sync
- Conflict detection: local edit vs remote edit
- Atomic: single SQLite transaction updates entry + vector + sync_status

## Phase 5: Huly Sync Adapter (TBD)

**Goal:** Bidirectional sync between unified_entries (type=task) and Huly issues.

### Design Decisions (pending)
- Poll vs webhook for Huly → memory-unified
- Which Huly fields map to which unified_entries columns
- Conflict resolution strategy (last-write-wins vs manual)
- Sync frequency (realtime webhook preferred, poll fallback)

### Architecture
```
Huly API ←→ HulySyncAdapter ←→ unified_entries (SQLite + sqlite-vec)
                                    ↕
                              OpenClaw agent tools
```

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| sqlite-vec search quality differs from LanceDB | Medium | Phase 2 dual-read comparison |
| BigInt edge cases on different platforms | Low | Comprehensive test suite |
| LanceDB removal breaks existing installs | High | Migration script + backup |
| Huly API changes | Medium | Adapter pattern, version pinning |
| Schema migration on production DBs | Medium | ALTER TABLE (safe, additive only) |

---
*Last edited by Wiki — 2026-03-04 20:45 UTC*
