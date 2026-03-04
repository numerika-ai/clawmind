# OpenClaw Unified Memory Architecture

**Version:** 2.0  
**Status:** Production (Phase 2 Complete)  
**Last Updated:** March 4, 2026

## Overview

The `memory-unified` plugin provides a zero-cost semantic memory layer for OpenClaw agents, combining **SQLite** for structured data with **LanceDB** for vector search and **Qwen3-Embedding** for local embeddings.

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway (Tank)                           │
├───────────────────────────────────────────┬──────────────────────────┤
│              memory-unified plugin          │    Infrastructure         │
├─────────────────┬─────────────────────────┼──────────────────────────┤
│  SQLite (OLTP)  │   LanceDB (Vector)      │    GPU Embeddings        │
│                 │                         │                          │
│ • unified_entries│ • 4096-dim vectors     │ • Qwen3-Embedding 8B     │
│ • skills         │ • Arrow/Parquet format │ • NVIDIA GB10 Blackwell  │
│ • conversations  │ • Disk-based storage   │ • 128GB unified memory    │
│ • tool_calls     │ • Filtered search      │ • CUDA 13.0              │
│ • FTS5 search    │ • Delete/update support│ • 15.4GB VRAM used       │
│                 │                         │                          │
│ Path: skill-memory.db                     │ Host: Spark (192.168.1.80)│
│ Size: ~50MB (7700+ entries)               │ Port: 11434 (Ollama)     │
└─────────────────┴─────────────────────────┴──────────────────────────┘
```

## Infrastructure Setup

### Hardware Architecture

| Component | Host | Specifications | Role |
|-----------|------|----------------|------|
| **Tank** | 192.168.1.100 | AMD Ryzen 9 7900X, RTX 3090 24GB, 16GB RAM | Gateway, SQLite, LanceDB |
| **Spark** | 192.168.1.80 | NVIDIA Grace (ARM), GB10 Blackwell 128GB, 120GB RAM | Ollama, Embedding Service |
| **Loco39** | 192.168.1.76 | AMD Ryzen 9 7900X, 64GB RAM (no GPU) | Huly PM (planned Phase 3) |

### GPU Configuration

**NVIDIA GB10 Blackwell on Spark:**
- **Memory:** 128GB unified memory
- **CUDA Version:** 13.0
- **Driver:** 580.126.09
- **Model Size:** 7.6B parameters (Q4_K_M quantized)
- **VRAM Usage:** 15.4GB for Qwen3-Embedding
- **Idle Power:** ~3W
- **Embedding Latency:** ~50ms over LAN

## Data Storage

### LanceDB Vector Store (Tank)

```python
# Schema equivalent (Lance/Arrow format)
schema = {
    "id": "int64",
    "content_hash": "string",
    "vector": "fixed_size_list<float32>[4096]",  # Qwen3 embeddings
    "metadata": "string"                         # JSON: type, tags, namespace
}

# Storage path: memory-vectors.lance
# Format: Apache Arrow with Parquet backing
# Index: IVF_PQ for fast approximate search
# Capabilities: filtered search, updates, deletes
```

## Entry Types & Statistics

| Type | Count | Purpose | Example |
|------|-------|---------|---------|
| **skill** | 99 | Learned procedures | "Deploy via Docker Compose" |
| **tool** | 6,500+ | Tool execution logs | "ffmpeg conversion with flags" |
| **config** | 128 | Infrastructure settings | "Spark GPU: 192.168.1.80:11434" |
| **history** | 800+ | Conversation logs | "User prefers terse responses" |
| **protocol** | 45 | SOPs and workflows | "Subagent spawn protocol" |
| **result** | 200+ | Task deliverables | "Training run: 0.89 AUC" |
| **task** | 150+ | Work items | "Update memory docs — TODO" |
| **file** | 80+ | Indexed workspace files | "TOOLS.md content indexed" |

**Total Entries:** 7,700+  
**Total Vectors:** 6,500+  
**Storage Size:** ~80MB (SQLite) + ~200MB (LanceDB)

## Embedding Service

### Qwen3-Embedding Setup (Spark)

**Model Specifications:**
- **Base Model:** Qwen3-Embedding-8B
- **Quantization:** Q4_K_M (4-bit)
- **Parameters:** 7.6B
- **Dimensions:** 4096
- **Context Length:** 8192 tokens
- **Format:** GGUF

**Plugin Configuration:**
```json
{
  "embedding": {
    "provider": "ollama",
    "endpoint": "http://192.168.1.80:11434",
    "model": "qwen3-embedding:8b",
    "dimensions": 4096,
    "timeout": 10000
  }
}
```

## Comparison with Alternatives

| Feature | memory-unified | Polsia | Mem0 | LangChain Memory |
|---------|----------------|--------|------|------------------|
| **Storage** | SQLite + LanceDB | PostgreSQL + pgvector | MongoDB + Qdrant | Configurable |
| **Embeddings** | Local Qwen3 (free) | OpenAI ($) | OpenAI ($) | OpenAI ($) |
| **Search** | Hybrid (FTS5 + vector) | Vector only | Vector only | Vector only |
| **Cost/Month** | $0 | ~$50 | ~$30 | ~$40 |
| **Latency** | ~50ms (LAN) | ~200ms (API) | ~150ms (API) | ~180ms (API) |
| **Offline** | ✅ Full | ❌ No | ❌ No | ❌ No |

## Phase 3 Roadmap: Task-Memory Integration

### Planned Features

1. **Huly Integration** (Q2 2026)
   - Bidirectional sync with Huly project management
   - Task creation from memory entries
   - Status tracking: TODO → IN_PROGRESS → REVIEW → DONE
   - Webhook notifications to agents

2. **Advanced Analytics** (Q3 2026)
   - Skill performance dashboards
   - Agent collaboration metrics
   - Memory usage patterns
   - Success rate trending

3. **Golden Path Automation** (Q4 2026)
   - Auto-detect successful task patterns
   - Generate skill procedures from execution logs
   - A/B testing for procedure improvements
   - Community skill sharing

## Performance Characteristics

### Benchmarks (Current Production Load)

| Metric | Value | Notes |
|--------|-------|--------|
| **Search Latency** | 45ms avg | FTS5: 5ms, Vector: 40ms |
| **Storage Growth** | 2MB/day | ~700 entries/day |
| **Memory Usage** | 150MB RSS | Plugin + SQLite cache |
| **GPU Memory** | 15.4GB | Qwen3 model on Spark |
| **Network Traffic** | 50KB/query | Embedding + results |
| **Disk I/O** | 1MB/s avg | SQLite WAL + LanceDB |

### Scaling Projections

| Scale | Entries | Vectors | Storage | Search Time | Notes |
|-------|---------|---------|---------|-------------|--------|
| **Current** | 7.7K | 6.5K | 280MB | 45ms | Production |
| **1M entries** | 1M | 800K | 35GB | 60ms | IVF_PQ index |
| **10M entries** | 10M | 8M | 350GB | 80ms | Multi-GPU? |

## Troubleshooting Common Issues

### GPU/CUDA Problems

**Symptom:** `size_vram: 0` in Ollama logs
```bash
# Check NVIDIA runtime
docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.0-base nvidia-smi

# Configure nvidia-ctk
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verify Ollama GPU access
docker logs ollama | grep -i gpu
```

**Symptom:** Slow embedding generation (>500ms)
- Check network latency: `ping 192.168.1.80`
- Verify GPU utilization: `nvidia-smi` on Spark
- Consider model quantization: Q4_K_M vs Q8_0

---

**Authors:** Wiki (architecture), Bartosz (concept)  
**Last Review:** March 4, 2026  
**Next Review:** June 2026 (Phase 3 planning)
