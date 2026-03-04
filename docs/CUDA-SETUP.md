# CUDA Setup Guide for Qwen3 Embeddings

This guide walks through setting up **Qwen3-Embedding 8B** on NVIDIA GPU using Ollama for the `memory-unified` plugin.

## Prerequisites

- NVIDIA GPU with 16GB+ VRAM (tested on GB10 Blackwell 128GB, RTX 3090 24GB)
- Docker with NVIDIA Container Toolkit
- Linux host (Ubuntu 20.04+ recommended)

## Overview

The embedding pipeline runs on GPU via Ollama:

```
memory-unified plugin → HTTP → Ollama → CUDA → Qwen3-8B → 4096-dim vectors
```

**Performance Targets:**
- Embedding latency: <100ms
- Model memory: ~15GB VRAM
- Throughput: 50+ embeddings/second

## Step 1: Install NVIDIA Container Toolkit

### Ubuntu/Debian

```bash
# Add NVIDIA package repository
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# Install toolkit
sudo apt update
sudo apt install -y nvidia-container-toolkit

# Configure Docker runtime
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Verify Installation

```bash
# Check Docker can access GPU
docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.0-base nvidia-smi

# Expected output: GPU information table
```

**Troubleshooting:** If you see "nvidia-smi: command not found":
- Check NVIDIA drivers: `nvidia-smi` (outside Docker)
- Verify `/usr/bin/nvidia-container-runtime` exists
- Restart Docker daemon: `sudo systemctl restart docker`

## Step 2: Deploy Ollama with GPU Support

### Docker Compose (Recommended)

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    runtime: nvidia
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,utility
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

volumes:
  ollama-data:
```

### Launch Service

```bash
# Start Ollama
docker compose up -d

# Check logs
docker logs ollama

# Verify GPU detection
docker exec ollama nvidia-smi
```

**Expected log output:**
```
time=2026-03-04T01:00:00.000Z level=INFO source=gpu.go:102 msg="Initializing GPU" id=0 library=cuda compute=8.9 driver=12.0 name="NVIDIA GB10 Blackwell" total="128.0 GiB"
```

## Step 3: Install Qwen3-Embedding Model

### Pull Model

```bash
# Download model (7.6GB)
docker exec ollama ollama pull qwen3-embedding:8b

# Verify installation
docker exec ollama ollama list
```

**Expected output:**
```
NAME                     ID              SIZE      MODIFIED
qwen3-embedding:8b      sha256:abc123   7.6 GB    2 minutes ago
```

### Model Information

```bash
# Check model details
docker exec ollama ollama show qwen3-embedding:8b
```

**Key specifications:**
- **Parameters:** 7.6B (Q4_K_M quantized)
- **Dimensions:** 4096
- **Context Length:** 8192 tokens
- **VRAM Usage:** ~15.4GB
- **Format:** GGUF

### Memory Requirements

| GPU | VRAM | Status | Notes |
|-----|------|--------|--------|
| **GB10 Blackwell** | 128GB | ✅ Recommended | Unified memory, optimal performance |
| **RTX 4090** | 24GB | ✅ Works | 8GB free after model load |
| **RTX 3090** | 24GB | ✅ Works | 8GB free, may need other service limits |
| **RTX 3080** | 10GB | ❌ Too small | Need 16GB+ for Q4_K_M |

## Troubleshooting

### GPU Not Detected

**Symptom:** `size_vram: 0` in Ollama logs

```bash
# Check NVIDIA runtime setup
docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.0-base nvidia-smi

# If fails, reconfigure runtime
sudo nvidia-ctk runtime configure --runtime=docker --set-as-default
sudo systemctl restart docker

# Check Docker daemon config
cat /etc/docker/daemon.json
# Should contain:
{
  "runtimes": {
    "nvidia": {
      "path": "nvidia-container-runtime",
      "runtimeArgs": []
    }
  }
}
```

---

**Tested Configurations:**
- NVIDIA GB10 Blackwell (128GB) + Docker + Ubuntu 22.04 ✅
- NVIDIA RTX 3090 (24GB) + Docker + Ubuntu 20.04 ✅  
- NVIDIA RTX 4090 (24GB) + Docker + Ubuntu 22.04 ✅

**Last Updated:** March 4, 2026  
**Next Review:** Model updates, performance optimizations
