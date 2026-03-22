# CLAUDE.md — Memory-Unified Plugin Phase 4 (Smart Data Strategy)

## Context
Plugin: `memory-unified` for OpenClaw — unified memory layer (SQLite + sqlite-vec + RAG pipeline).
Repo: `https://github.com/numerika-ai/openclaw-memory-unified`
Branch: `main` (Phase 1 merged: `5bead01`)
Full audit: `UPGRADE-PLAN.md` (w tym katalogu).

## Current State (2026-03-21 18:45 UTC)

### Models running on RTX 3090 (Tank VM)
| Model | Port | VRAM | Dimensions | API |
|-------|------|------|------------|-----|
| **Qwen3-Embedding-8B** (FP16) | 8080 | 15 GB | **4096** | OpenAI-compatible `/v1/embeddings` |
| **Nemotron Rerank 1B v2** (FP16) | 8082 | 2.6 GB | — | POST `/rerank` `{query, texts}` → `{results: [{index, score}]}` |
| **Whisper large-v3** (Docker) | 9000 | ~3 GB | — | faster-whisper API |

### ENV vars (systemd drop-in)
```
QWEN_EMBED_URL=http://localhost:8080/v1/embeddings
QWEN_MODEL=Qwen3-Embedding-8B
EMBED_DIM=4096
RERANK_URL=http://localhost:8082/rerank
RERANK_ENABLED=true
MEMORY_VECTOR_BACKEND=sqlite-vec
```

### DB state (post Phase 4 cleanup)
- `skill-memory.db`: **37 MB** (was 204 MB — 82% reduction)
- `unified_entries`: 792 rows (18,498 tool entries deleted)
- `vec_entries_staging`: 0 (17,483 orphaned blobs cleared)
- `vec_entries_rowids` / `hnsw_meta`: 786 vectors indexed
- `memory_facts`: 28 active facts
- `unified_fts`: 792 entries (rebuilt from scratch)
- Entry breakdown: history(444), config(145), skill(106), file(50), task(23), result(13), protocol(8), tool(3)

### Smart Tool Logging (Phase 4)
Only these tools are logged (whitelist): `sessions_spawn`, `message`, `gateway`, `cron`, `unified_store`.
All others (exec, read, write, process, web_fetch) are skipped — 95% noise reduction.
Config: `logToolCallsFilter` can be `"whitelist"` (default), `"all"`, `"none"`, or `string[]` of tool names.

### Maintenance (runs on startup)
1. TTL expiry + confidence decay (memory_facts)
2. Pattern GC (stale patterns < 0.1 confidence, > 30 days)
3. Data cleanup: delete tool entries, clear staging, vacuum
4. Purge tool entries > 7 days, archive stale conversations > 7 days
5. FTS5 auto-rebuild if corrupted

## Build & Test
```bash
npm run build          # TypeScript → dist/
# Zero errors required. Check with:
grep -r "ollama" dist/ # must return nothing
grep -r "lancedb" dist/ # must return nothing
grep -r "2048" dist/   # should only appear in comments, not in CREATE TABLE
```

## Rules
- **NEVER** use `rm` — move to `.trash/` directory instead
- **NEVER** modify `openclaw.json`
- **NEVER** restart the gateway (Wiki does that)
- Run `npm run build` after ALL changes — must pass with zero errors
- Commit changes to `main` branch, push to origin
- Check TypeScript types before committing

---

## Step-by-Step Implementation (Phase 2 — Post-Review Fixes)

### Step 1: Fix hardcoded `float[2048]` in sqlite-vec.ts — CRITICAL

**Problem:** `initTable()` hardcodes `float[2048]` in CREATE TABLE. Should read from `EMBED_DIM` env.

**File:** `src/db/sqlite-vec.ts` line 14-19

**Current:**
```typescript
this.db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
        entry_id INTEGER PRIMARY KEY,
        embedding float[2048] distance_metric=cosine,
        entry_type TEXT,
        +text TEXT
    );
`);
```

**Fix:** Import EMBED_DIM from nemotron.ts and use it:
```typescript
import { EMBED_DIM } from "../embedding/nemotron";
// ...
this.db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
        entry_id INTEGER PRIMARY KEY,
        embedding float[${EMBED_DIM}] distance_metric=cosine,
        entry_type TEXT,
        +text TEXT
    );
`);
```

Also check if `memory_facts_vec` creation (in `src/index.ts` or `src/memory-bank/`) has the same hardcoded dimension.

### Step 2: Fix nemotron.ts legacy mode — Qwen3 doesn't need prefixes

**Problem:** When `QWEN_EMBED_URL` env is set, code enters "legacy mode" that:
- Truncates input to 2000 chars (should be 7500+ for 8K context model)
- Skips query/passage prefixes (correct for Qwen3, but limit is wrong)
- Uses hardcoded model name `qwen3-embedding:8b`

**File:** `src/embedding/nemotron.ts`

**Fix:** 
- Remove `USE_QWEN_LEGACY` distinction — we only have one backend now (Qwen3 on port 8080)
- Use `EMBED_URL` as the canonical env (keep `QWEN_EMBED_URL` as fallback)
- Increase text limit to 7500 chars (Qwen3 supports 32K tokens)
- Remove `QUERY_PREFIX` / `PASSAGE_PREFIX` (Qwen3 doesn't use them)
- Update `EMBED_MODEL` default to `Qwen3-Embedding-8B`
- Update `EMBED_DIM` default to `4096`

### Step 3: Update config.ts defaults

**File:** `src/config.ts`

**Changes:**
- `embeddingDim` default: `2048` → `4096`
- `embeddingModel` default: `nvidia/llama-nemotron-embed-1b-v2` → `Qwen/Qwen3-Embedding-8B`
- Keep backward compat: env vars override config

### Step 4: Rename lance-manager.ts → vector-manager.ts

**Problem:** File name references LanceDB which is removed. Class is already `VectorManager`.

**Action:** 
- Rename `src/db/lance-manager.ts` → `src/db/vector-manager.ts`
- Update all imports in `src/index.ts`, `src/hooks/rag-injection.ts`, etc.
- Keep `NativeLanceManager` re-export for backward compatibility

### Step 5: Update README.md

**Current:** Says "Nemotron Embed 1B v2, 2048-dim, LanceDB"
**Fix:** Update to reflect:
- Qwen3-Embedding-8B, 4096-dim
- sqlite-vec only (no LanceDB)
- Updated architecture diagram (VRAM: ~20.6 GB)
- Remove Ollama references
- Update installation options table

### Step 6: Git commit + push

Commit message: `fix: Phase 2 — Qwen3-8B defaults, dynamic EMBED_DIM, rename vector-manager`

Push to `origin main`.

## Step-by-Step Implementation (Phase 3 — Extraction Loop Fix)

### Problem
Memory Bank extraction sends "You are a memory extraction system..." prompt to gateway (localhost:18789).
Gateway treats it as a normal message → runs full RAG pipeline (FTS5 + vector search + rerank).
FTS5 matches "memory" and "system" → hits skill "session-logs" → extra LLM call → 2-3x per user message.
This adds 5-8 seconds latency and wastes Anthropic tokens.

### Step 1: Skip RAG for internal extraction calls

**File:** `src/hooks/rag-injection.ts`

In the main `before_agent_start` handler, add an early return at the TOP of the function (before any FTS5/vector/rerank logic):

```typescript
// Skip RAG pipeline for internal Memory Bank extraction calls
const userMsg = event?.messages?.find((m: any) => m.role === "user");
const userText = typeof userMsg?.content === "string" ? userMsg.content : "";
if (userText.startsWith("You are a memory extraction system")) {
  return; // extraction doesn't need skill matching or vector search
}
```

This must be the FIRST check in the handler, before any database queries.

### Step 2: Clean up phantom conversations

**File:** `src/index.ts` (or a new file `src/maintenance/cleanup.ts`)

Add a one-time cleanup on plugin startup (in the init function, after DB is ready):

```typescript
// Clean up phantom conversations created by extraction loop
db.exec(`
  UPDATE conversations SET status = 'archived' 
  WHERE topic LIKE 'You are a memory extraction system%'
     OR topic LIKE 'Extract facts:%'
`);
```

This archives ~131 junk conversation threads. Run once on startup, idempotent.

### Step 3: Update README.md

Add a "Known Issues (Fixed)" section documenting the extraction loop bug and fix.

### Step 4: Update UPGRADE-PLAN.md

Mark Phase 3 as DONE in the plan document.

### Step 5: Git commit + push

Commit message: `fix: skip RAG pipeline for internal extraction calls (Phase 3)`

Push to `origin main`.

## Verification Checklist

After all changes:
- [ ] `npm run build` — zero errors
- [ ] `grep -r "extraction" dist/hooks/rag-injection.js` — should show the early return check
- [ ] Gateway restart → check logs: extraction calls should NOT trigger "TOOL ROUTING — skill session-logs"
- [ ] User messages still get full RAG (FTS5 + vector + rerank)
- [ ] `SELECT count(*) FROM conversations WHERE status='active' AND topic LIKE 'You are a memory%'` → 0
- [ ] README documents the fix
- [ ] All imports resolve correctly

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **memory-unified** (200 symbols, 491 relationships, 8 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/memory-unified/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/memory-unified/context` | Codebase overview, check index freshness |
| `gitnexus://repo/memory-unified/clusters` | All functional areas |
| `gitnexus://repo/memory-unified/processes` | All execution flows |
| `gitnexus://repo/memory-unified/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
