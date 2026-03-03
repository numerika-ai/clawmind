# memory-unified — OpenClaw Plugin

Unified memory layer for [OpenClaw](https://github.com/openclaw/openclaw) that merges **USMD SQLite** skill database with **Ruflo HNSW** vector search. Gives your AI agent structured + semantic long-term memory.

## Features

- **Dual storage:** SQLite for structured data (skills, tool calls, artifacts) + HNSW for semantic search
- **RAG on agent start:** injects relevant micro-summaries from vector memory into context
- **Tool call logging:** every tool invocation stored with auto-tags for trajectory analysis
- **Skill learning:** tracks skill executions, success rates, and proposes procedure improvements
- **Unified search:** single `unified_search` tool queries both backends simultaneously

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    memory-unified plugin                     │
├─────────────────────┬───────────────────────────────────────┤
│   USMD SQLite       │          Ruflo HNSW                   │
│   (structured)      │          (semantic)                   │
│                     │                                       │
│ • skills table      │ • ruflo_memory_store (ns: unified)    │
│ • skill_executions  │ • ruflo_memory_search (vector sim)    │
│ • unified_entries   │ • trajectory tracking (SONA)          │
│ • tool_calls        │                                       │
│ • artifacts         │                                       │
└─────────────────────┴───────────────────────────────────────┘
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

The plugin exposes these tools to your AI agent:

| Tool | Description |
|------|-------------|
| `unified_search` | Search across USMD + HNSW (structured + semantic). Supports filtering by entry type |
| `unified_store` | Store entry to both backends with auto-tagging and summarization |
| `unified_conversations` | List and search conversation threads |

## Schema

The SQLite database includes:

- **skills** — learned procedures with success rates
- **skill_executions** — execution history with timing and token usage
- **unified_entries** — bridge table linking USMD ↔ HNSW entries
- **tool_calls** — tool invocation log
- **artifacts** — tracked files and outputs
- **procedure_proposals** — proposed skill improvements

See [schema.sql](schema.sql) for full DDL.

## Hooks

| Hook | Action |
|------|--------|
| `before_agent_start` | RAG slim: injects micro-summaries (20-30 tokens + keys) |
| `after_tool_call` | Logs tool call to USMD + HNSW with auto-tags |
| `agent_end` | Ends SONA trajectory with success/failure label |

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
