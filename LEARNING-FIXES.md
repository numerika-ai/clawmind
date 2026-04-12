# LEARNING-FIXES.md — Memory Learning System Fixes

**Date**: 2026-03-24
**Problem**: Wiki keeps repeating the same mistakes because lessons are stored but never fed back into decision-making.

## Changes Made

### Fix 1: Lessons Learned Guardrails Injection
**Files**: `src/hooks/rag-injection.ts`, `src/memory-bank/topics.ts`, `src/memory-bank/extractor.ts`

- Added `lessons_learned` as a first-class topic (priority 10, no TTL) in `topics.ts`
- Added `lessons_learned` to the extraction prompt's valid topics in `extractor.ts`
- Added STEP 7 in `rag-injection.ts`: always queries top 5 `lessons_learned` facts (both agent-scoped and global) and injects them as a prominent `## GUARDRAILS` section at the TOP of the `<unified-memory>` context block
- Guardrails appear before skill procedures and other context, ensuring the agent sees them first
- Facts with `repeated_count > 1` get a `⚠️ REPEATED:` prefix for extra visibility

### Fix 2: Error Repetition Detection
**Files**: `src/memory-bank/consolidator.ts`, `src/db/port.ts`, `src/db/sqlite.ts`, `src/db/sqlite-port.ts`, `src/db/postgres.ts`

- Added `repeated_count` column to `memory_facts` (SQLite) and `agent_knowledge` (Postgres) via migrations
- Added `incrementFactRepeatedCount()` method to `DatabasePort` interface and both backend implementations
- Modified consolidator: when a new `lessons_learned` fact has similarity > 0.85 with an existing one, confidence is forced to 1.0 and `repeated_count` is incremented (instead of the normal > 0.95 threshold for other topics)
- In RAG injection, facts with `repeated_count > 1` are prefixed with `⚠️ REPEATED:` to flag recurring mistakes

### Fix 3: Before-Compaction Lesson Extraction
**Files**: `src/hooks/on-turn-end.ts`, `src/index.ts`

- Added `createCompactionHook()` in `on-turn-end.ts` — registered on the `before_compaction` event
- When OpenClaw compacts conversation context, this hook extracts lessons/mistakes/corrections using a specialized prompt focused on: errors made, "don't do X" rules, corrections from users, and guardrails discovered
- Extracted facts are stored as `lessons_learned` topic with `permanent` temporal type and 0.9 confidence
- Goes through the normal consolidation pipeline (dedup, contradiction detection)

### Fix 4: Enhanced Pattern-Based Warnings
**Files**: `src/hooks/rag-injection.ts`

- Lowered pattern query threshold from `minConfidence: 0.3` to `minConfidence: 0.05` to also surface failure patterns
- Patterns with confidence < 0.2 (indicating repeated failures) are now injected into the guardrails section as warnings: "Pattern X has failed repeatedly — consider a different approach"
- High-confidence patterns (> 0.4) continue to appear as `[pattern]` lines as before

## How It Works End-to-End

1. **Learning**: When errors happen, the extraction system captures them as `lessons_learned` facts
2. **Reinforcement**: If the same lesson is learned again (similarity > 0.85), `repeated_count` increments and confidence locks at 1.0
3. **Injection**: Every RAG query injects top 5 lessons as a prominent guardrails block at the context top
4. **Compaction safety**: Before context is trimmed, all lessons from the conversation are extracted and persisted
5. **Pattern warnings**: Failed patterns surface as warnings in guardrails, not just as passive context lines

## Verification

```bash
npm run build  # zero errors
```
