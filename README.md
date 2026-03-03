# memory-unified — OpenClaw Plugin

Unified memory layer for [OpenClaw](https://github.com/openclaw/openclaw) that merges **USMD SQLite** skill database with **HNSW** vector search. Gives your AI agent structured + semantic long-term memory with task tracking.

## Features

### Memory & Search
- **Dual storage:** SQLite (structured) + HNSW (semantic vector search) in one plugin
- **FTS5 full-text search:** fast keyword matching across all stored skills and entries
- **Semantic search:** Qwen3-Embedding 4096-dim vectors via native `hnswlib-node` (no external vector DB needed)
- **Unified search tool:** `unified_search` queries both SQL + HNSW simultaneously, merges and ranks results

### Entry Types
| Type | Purpose | Example |
|------|---------|---------|
| `skill` | Learned procedures, SKILL.md files | "How to deploy via Docker" |
| `protocol` | Reusable workflows, SOPs | "Subagent spawn protocol" |
| `config` | Infrastructure, architecture, settings | "Server IPs, Docker ports" |
| `history` | General facts, conversation logs | "User prefers dark mode" |
| `tool` | Tool usage patterns, results | "ffmpeg conversion flags" |
| `result` | Task outputs, deliverables | "Training run metrics" |
| `task` | Work items with status tracking | "Hardware scan — IN_PROGRESS" |

### Task Tracking
- **Active work:** `unified_store(type="task", tags="active,...")` — what the agent is working on now
- **Completed:** `unified_store(type="task", tags="done,...")` — finished items
- **Blocked:** `unified_store(type="task", tags="blocked,...")` — waiting on something
- **Query tasks:** `unified_search(type="task")` — find all tracked work items
- Tasks are indexed in both SQLite (structured query) and HNSW (semantic search)

### RAG (Retrieval-Augmented Generation)
- **RAG slim on agent start:** searches memory for context relevant to the user's message
- **Skill procedure injection:** matched skill procedures injected into context (`[SKILL MATCH]` blocks)
- **HNSW semantic injection:** top-K vector matches with similarity scores
- **Active thread injection:** recent conversation threads summarized for continuity
- **Task context:** active tasks surfaced in RAG results

### Skill Learning
- **Skill execution tracking:** logs every skill use with timing, token count, success/failure
- **Pattern recognition:** detects recurring patterns with confidence scoring
- **Pattern decay:** confidence degrades over time — stale patterns fade out
- **Procedure proposals:** proposes improved procedures based on execution history

### Conversation Memory
- **Conversation threads:** groups messages into threads with topics, tags, status
- **Thread lifecycle:** active → resolved → archived — queryable via `unified_conversations`
- **Cross-session continuity:** conversations persist across restarts and session rotations

### Agent Hooks
| Hook | Trigger | Action |
|------|---------|--------|
| `before_agent_start` | New message arrives | RAG slim: injects skills + HNSW + threads + patterns into context |
| `after_tool_call` | Any tool completes | Logs tool name, params, result to HNSW with auto-tags |
| `agent_end` | Session ends | Closes SONA trajectory with success/failure label |

### Trajectory Tracking (SONA)
- **Start/step/end lifecycle:** each agent session is a trajectory with quality-scored steps
- **Self-learning signal:** success/failure labels feed back into skill confidence and pattern updates
- **Ruflo MCP bridge:** optional integration with external Ruflo server for advanced analysis

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      memory-unified plugin                           │
├───────────────────────────┬──────────────────────────────────────────┤
│     USMD SQLite           │         Native HNSW (hnswlib-node)      │
│     (structured)          │         (semantic, 4096-dim)             │
│                           │                                          │
│ • skills                  │ • Qwen3-Embedding vectors                │
│ • skill_executions        │ • cosine similarity search               │
│ • unified_entries         │ • auto-embed on store                    │
│   (type: skill/protocol/  │ • 50K max elements                      │
│    config/history/tool/   │ • M=16, efConstruction=200               │
│    result/task)           │                                          │
│ • tool_calls              │                                          │
│ • patterns                ├──────────────────────────────────────────┤
│ • conversations           │         Ruflo MCP (optional)             │
│ • artifacts               │ • trajectory tracking                    │
│ • procedure_proposals     │ • external vector store                  │
└───────────────────────────┴──────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   FTS5 full-text              Ollama embeddings
   keyword search              (qwen3-embedding:8b)
```

## Installation

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) v0.40+ (memory plugin slot support)
- Node.js 22+
- **Embedding service** — one of:
  - [Ollama](https://ollama.ai) with `qwen3-embedding:8b` model (recommended, local, free)
  - Any OpenAI-compatible `/v1/embeddings` endpoint producing 4096-dim vectors

### Step 1: Set up embeddings

The plugin generates 4096-dimensional vectors using Qwen3-Embedding via Ollama.

```bash
# Install Ollama (if not installed)
curl -fsSL https://ollama.ai/install.sh | sh

# Pull the embedding model (~4.5GB)
ollama pull qwen3-embedding:8b

# Verify it works
curl http://localhost:11434/v1/embeddings \
  -d '{"model":"qwen3-embedding:8b","input":"test"}' | jq '.data[0].embedding | length'
# Should return: 4096
```

If Ollama runs on a different machine, set the env var:
```bash
export QWEN_EMBED_URL="http://YOUR_OLLAMA_HOST:11434/v1/embeddings"
```

### Step 2: Install the plugin

```bash
# Clone the repo
git clone https://github.com/numerika-ai/openclaw-memory-unified.git
cd openclaw-memory-unified

# Install dependencies
npm install

# Build TypeScript
npm run build

# Register in OpenClaw
openclaw plugin install ./
```

**Alternative — manual install:**
```bash
cp -r . ~/.openclaw/extensions/memory-unified/
cd ~/.openclaw/extensions/memory-unified/
npm install && npm run build
```

### Step 3: Configure OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-unified"
    },
    "entries": {
      "memory-unified": {
        "enabled": true,
        "config": {
          "dbPath": "~/.openclaw/workspace/skill-memory.db",
          "ragSlim": true,
          "logToolCalls": true,
          "trajectoryTracking": true,
          "ragTopK": 3
        }
      }
    }
  }
}
```

> **Note:** Setting `plugins.slots.memory` to `"memory-unified"` replaces OpenClaw's default memory handler. Only one memory plugin can be active at a time.

### Step 4: Restart

```bash
openclaw gateway restart
```

### What happens on first start

1. **SQLite database** is auto-created at `dbPath` (default: `~/.openclaw/workspace/skill-memory.db`)
2. All tables from [schema.sql](schema.sql) are applied (skills, executions, unified_entries, etc.)
3. **HNSW vector index** is created at `<dbPath-dir>/skill-memory.hnsw` (grows as data is stored)
4. Plugin registers tools (`unified_search`, `unified_store`, `unified_conversations`) with the agent
5. On each agent session start, RAG slim injects relevant memory snippets into context

No manual database setup needed — everything is auto-created on first run.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QWEN_EMBED_URL` | `http://localhost:11434/v1/embeddings` | Ollama embeddings endpoint URL |

Set in OpenClaw's env config for persistence:
```json
{
  "env": {
    "vars": {
      "QWEN_EMBED_URL": "http://localhost:11434/v1/embeddings"
    }
  }
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dbPath` | string | `skill-memory.db` | Path to SQLite database (created automatically) |
| `ragSlim` | boolean | `true` | Inject micro-summaries into agent context on start |
| `logToolCalls` | boolean | `true` | Store every tool call in HNSW with auto-tags |
| `trajectoryTracking` | boolean | `true` | Track agent trajectories for self-learning |
| `ragTopK` | number | `5` | Number of HNSW results to inject on agent start |

## Tools

### `unified_search`

Search across USMD skills and HNSW vector memory. Combines structured SQL + semantic search.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✅ | Search query |
| `type` | string | ❌ | Filter by entry type: `skill` / `protocol` / `config` / `history` / `tool` / `result` / `task` |
| `limit` | number | ❌ | Max results (default: 10) |

**Examples:**
```
unified_search(query="Docker containers on Tank")
unified_search(query="active work", type="task")
unified_search(query="training baseline", type="config", limit=5)
```

### `unified_store`

Store an entry in both USMD SQLite and HNSW. Auto-tags and summarizes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | ✅ | Content to store |
| `type` | string | ❌ | Entry type: `skill` / `protocol` / `config` / `history` / `tool` / `result` / `task` (default: `history`) |
| `tags` | string | ❌ | Comma-separated tags |
| `source_path` | string | ❌ | Source file path |

**Examples:**
```
# Store a skill
unified_store(content="How to restart collectors...", type="skill", tags="collectors,spark")

# Track a task
unified_store(content="Hardware scan — IN_PROGRESS", type="task", tags="active,infrastructure")

# Store infrastructure config
unified_store(content="Tank IP: 192.168.1.100, RTX 3090", type="config", tags="infrastructure,gpu")
```

**Task tracking convention:**

| Status | Tags | Meaning |
|--------|------|---------|
| Active | `active,...` | Currently being worked on |
| Done | `done,...` | Completed successfully |
| Blocked | `blocked,...` | Waiting on external input |

### `unified_conversations`

List or search conversation threads. Use to recall what was discussed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | ❌ | Filter: `active` / `resolved` / `blocked` / `archived` / `all` (default: `active`) |
| `query` | string | ❌ | Search topic/tags/summary |
| `limit` | number | ❌ | Max results (default: 10) |
| `details` | boolean | ❌ | Include full details and messages (default: false) |

**Examples:**
```
unified_conversations()                              # active threads
unified_conversations(status="all", query="Docker")  # search all threads
unified_conversations(status="resolved", limit=5)    # recent completed
```

## Schema

The SQLite database includes:

| Table | Purpose |
|-------|---------|
| `skills` | Learned procedures with success rates |
| `skill_executions` | Execution history with timing and token usage |
| `unified_entries` | All stored entries (7 types) with FTS5 index |
| `tool_calls` | Tool invocation log |
| `artifacts` | Tracked files and outputs |
| `patterns` | Detected recurring patterns with confidence |
| `pattern_history` | Pattern confidence changes over time |
| `conversations` | Conversation threads with lifecycle |
| `conversation_messages` | Individual messages within threads |
| `procedure_proposals` | Proposed skill improvements |
| `hnsw_meta` | HNSW embedding metadata |

See [schema.sql](schema.sql) for full DDL.

## Migration

Migrate existing USMD skills to Ruflo HNSW:

```bash
npx ts-node migrate.ts                     # default DB path
npx ts-node migrate.ts --db /path/to/db    # custom path
```

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build
```

## License

MIT

## Links

- [OpenClaw](https://github.com/openclaw/openclaw) — AI agent framework
- [OpenClaw Docs](https://docs.openclaw.ai)
- [ClaWHub Skills](https://clawhub.com) — community skills marketplace
