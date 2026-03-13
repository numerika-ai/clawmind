# Memory Bank — Local-First Implementation Spec

## Overview
Inspired by Google Vertex AI Memory Bank, but running 100% locally:
- LLM-powered fact extraction from conversations (Ollama on Spark)
- Memory consolidation (merge, update, conflict detection)
- Topic-based organization
- TTL + revision history

## New SQLite Tables

```sql
CREATE TABLE IF NOT EXISTS memory_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    fact TEXT NOT NULL,
    confidence REAL DEFAULT 0.8,
    source_type TEXT DEFAULT 'conversation',
    source_session TEXT,
    source_summary TEXT,
    agent_id TEXT DEFAULT 'main',
    ttl_days INTEGER DEFAULT NULL,
    access_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expired_at TIMESTAMP DEFAULT NULL,
    hnsw_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_topic ON memory_facts(topic);
CREATE INDEX IF NOT EXISTS idx_facts_agent ON memory_facts(agent_id);
CREATE INDEX IF NOT EXISTS idx_facts_confidence ON memory_facts(confidence);

CREATE TABLE IF NOT EXISTS memory_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id INTEGER NOT NULL REFERENCES memory_facts(id),
    revision_type TEXT CHECK(revision_type IN ('created','updated','merged','expired','manual_edit')) NOT NULL,
    old_content TEXT,
    new_content TEXT,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memory_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    description TEXT,
    extraction_prompt TEXT,
    ttl_days INTEGER DEFAULT NULL,
    priority INTEGER DEFAULT 5,
    enabled INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Default Topics
| Topic | Description | TTL | Priority |
|-------|-------------|-----|----------|
| user_preferences | User preferences, habits, style | NULL | 9 |
| technical_facts | Configs, architectures, versions | 90d | 8 |
| project_context | Active project details, goals | 30d | 7 |
| instructions | Explicit user rules | NULL | 10 |
| people_orgs | People, organizations | NULL | 6 |
| decisions | Key decisions + reasoning | 60d | 7 |
| learned_patterns | Patterns from interactions | 90d | 5 |

## Extraction Pipeline (agent_end hook)
1. Filter: skip short (<100 chars), cron/heartbeat, system messages
2. Send conversation to Ollama (Spark) with extraction prompt
3. Parse JSON array of facts
4. Per fact: semantic search existing (Qwen3, cosine)
   - >0.95: boost confidence only
   - 0.90-0.95: update content
   - 0.85-0.90: LLM merge decision
   - <0.85: create new
5. Store in SQLite + embed in HNSW
6. Log revision

## LLM Config
- URL: http://192.168.1.80:11434/v1/chat/completions
- Model: qwen3:32b (primary), qwen3:8b (fast mode)
- Extraction prompt returns JSON array of {fact, topic, confidence}

## RAG Integration
Extend before_agent_start: semantic search memory_facts top 5 → inject as ## Memory Bank

## Config Extension
```typescript
memoryBank: {
  enabled: boolean;              // true
  extractionModel: string;       // 'qwen3:32b'
  extractionUrl: string;         // 'http://192.168.1.80:11434/v1/chat/completions'
  minConversationLength: number; // 100
  consolidationThreshold: number;// 0.85
  maxFactsPerTurn: number;       // 10
  ragTopK: number;               // 5
}
```

## New Files
- src/memory-bank/types.ts
- src/memory-bank/extractor.ts
- src/memory-bank/consolidator.ts
- src/memory-bank/topics.ts
- src/memory-bank/index.ts

## Modified Files
- schema.sql — add 3 tables
- src/config.ts — memoryBank config
- src/db/sqlite.ts — memory_facts CRUD
- src/hooks/on-turn-end.ts — trigger extraction
- src/hooks/rag-injection.ts — inject facts
- src/tools/unified-search.ts — include facts in search
- src/index.ts — wire up

## Implementation Order
Phase 1: Tables + types + seed topics
Phase 2: Extractor + consolidator
Phase 3: Hook integration
Phase 4: TTL cleanup + confidence decay
Phase 5: Search tool extension
Phase 6: Config + build + test
