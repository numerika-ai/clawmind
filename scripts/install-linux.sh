#!/bin/bash
# =============================================================================
# install-linux.sh — Install memory-unified + openclaw on Linux (Ubuntu/Debian)
#
# Usage: curl -fsSL https://raw.githubusercontent.com/numerika-ai/clawmind/main/scripts/install-linux.sh | bash
# =============================================================================

set -euo pipefail

echo "=============================================="
echo " memory-unified + openclaw — Linux installer"
echo "=============================================="

# ------- Config (edit these) -------
NUMERIKA_API_URL="${NUMERIKA_API_URL:-https://api.numerika.ai}"
NUMERIKA_API_KEY="${NUMERIKA_API_KEY:-}"
PG_DB="${PG_DB:-openclaw_platform}"
PG_USER="${PG_USER:-openclaw}"
PG_PASS="${PG_PASS:-OpenClaw2026}"
MODEL="${MODEL:-qwen3.5-397b-thinking}"
# -----------------------------------

if [ -z "$NUMERIKA_API_KEY" ]; then
  echo ""
  echo "ERROR: Set NUMERIKA_API_KEY before running:"
  echo "  export NUMERIKA_API_KEY='sk-your-key-here'"
  echo "  bash install-linux.sh"
  exit 1
fi

echo ""
echo "API:   $NUMERIKA_API_URL"
echo "Model: $MODEL"
echo "DB:    $PG_DB"
echo ""

# 1. System deps
echo ">>> [1/8] System dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl git build-essential python3 2>/dev/null

# 2. Node.js
echo ">>> [2/8] Node.js..."
if ! command -v node &>/dev/null || [ "$(node --version | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "  node $(node --version)"

# 3. PostgreSQL + pgvector
echo ">>> [3/8] PostgreSQL + pgvector..."
if ! command -v psql &>/dev/null; then
  sudo apt-get install -y -qq postgresql postgresql-contrib
fi
sudo systemctl enable postgresql
sudo systemctl start postgresql

# Install pgvector
if ! sudo -u postgres psql -d postgres -tc "SELECT 1 FROM pg_extension WHERE extname='vector'" 2>/dev/null | grep -q 1; then
  sudo apt-get install -y -qq postgresql-16-pgvector 2>/dev/null || \
  sudo apt-get install -y -qq postgresql-server-dev-all && \
  cd /tmp && git clone --depth 1 https://github.com/pgvector/pgvector.git && \
  cd pgvector && make && sudo make install && cd .. && rm -rf pgvector
fi

# Create user + database
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $PG_USER WITH PASSWORD '$PG_PASS';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $PG_DB OWNER $PG_USER;"
sudo -u postgres psql -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d "$PG_DB" -c "CREATE SCHEMA IF NOT EXISTS openclaw AUTHORIZATION $PG_USER;"

PG_URL="postgresql://$PG_USER:$PG_PASS@localhost:5432/$PG_DB"
echo "  postgres: $PG_URL"

# 4. openclaw
echo ">>> [4/8] openclaw..."
if ! command -v openclaw &>/dev/null; then
  sudo npm install -g openclaw
fi
echo "  openclaw installed"

# 5. memory-unified plugin
echo ">>> [5/8] memory-unified plugin..."
PLUGIN_DIR="$HOME/.openclaw/extensions/memory-unified"
if [ -d "$PLUGIN_DIR" ]; then
  cd "$PLUGIN_DIR" && git pull origin main
else
  mkdir -p "$HOME/.openclaw/extensions"
  git clone https://github.com/numerika-ai/clawmind.git "$PLUGIN_DIR"
fi
cd "$PLUGIN_DIR"
npm install
npm run build
echo "  plugin built: $PLUGIN_DIR/dist/"

# 6. Apply schema
echo ">>> [6/8] Database schema..."
for sql in schema/*.sql; do
  if [ -f "$sql" ]; then
    PGPASSWORD="$PG_PASS" psql -h localhost -U "$PG_USER" -d "$PG_DB" -f "$sql" 2>/dev/null || true
    echo "  applied: $sql"
  fi
done

# 7. Plugin config
echo ">>> [7/8] Plugin config..."
mkdir -p "$HOME/.openclaw"

python3 -c "
import json, os

config_path = os.path.expanduser('~/.openclaw/openclaw.json')
try:
    cfg = json.load(open(config_path))
except:
    cfg = {}

cfg.setdefault('plugins', {}).setdefault('entries', {})
cfg['plugins']['entries']['memory-unified'] = {
    'enabled': True,
    'config': {
        'backend': 'postgres',
        'postgresUrl': '$PG_URL',
        'embeddingUrl': '$NUMERIKA_API_URL/v1/embeddings',
        'embeddingModel': 'qwen3-embedding-8b',
        'embeddingDim': 4096,
        'rerankEnabled': False,
        'ragSlim': True,
        'ragTopK': 5,
        'logToolCalls': True,
        'trajectoryTracking': True,
        'memoryBank': {
            'enabled': True,
            'extractionUrl': '$NUMERIKA_API_URL/v1/chat/completions',
            'extractionModel': '$MODEL',
            'extractionApiKey': '$NUMERIKA_API_KEY',
            'minConversationLength': 0,
            'consolidationThreshold': 0.85,
            'maxFactsPerTurn': 10,
            'ragTopK': 5
        }
    }
}

cfg.setdefault('models', {}).setdefault('providers', {})
cfg['models']['providers']['litellm'] = {
    'baseUrl': '$NUMERIKA_API_URL',
    'apiKey': '$NUMERIKA_API_KEY',
    'api': 'openai-completions',
    'models': [
        {'id': 'qwen3.5-397b-thinking', 'name': 'Qwen 3.5 397B (thinking)', 'reasoning': True, 'input': ['text'], 'contextWindow': 199000, 'maxTokens': 16384},
        {'id': 'qwen3.5-397b', 'name': 'Qwen 3.5 397B', 'reasoning': True, 'input': ['text'], 'contextWindow': 199000, 'maxTokens': 16384},
        {'id': 'gemini-3.1-pro', 'name': 'Gemini 3.1 Pro', 'reasoning': True, 'input': ['text'], 'contextWindow': 1048576, 'maxTokens': 32768}
    ]
}

cfg.setdefault('agents', {}).setdefault('defaults', {})
cfg['agents']['defaults']['model'] = {'primary': 'litellm/$MODEL', 'fallbacks': ['litellm/gemini-3.1-pro']}

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)
print('  config written')
"

# 8. Verify
echo ">>> [8/8] Verification..."
EMBED_TEST=$(curl -s --max-time 10 -H "Authorization: Bearer $NUMERIKA_API_KEY" -H "Content-Type: application/json" "$NUMERIKA_API_URL/v1/embeddings" -d '{"model":"qwen3-embedding-8b","input":"test"}' 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); e=d.get('data',[{}])[0].get('embedding',[]); print(f'OK dim={len(e)}') if e else print('FAIL')" 2>&1)
echo "  embedding: $EMBED_TEST"
PG_TEST=$(PGPASSWORD="$PG_PASS" psql -h localhost -U "$PG_USER" -d "$PG_DB" -tc "SELECT 'OK';" 2>&1 | tr -d ' ')
echo "  postgres: $PG_TEST"

echo ""
echo "=============================================="
echo " DONE! Start openclaw:"
echo "   openclaw"
echo ""
echo " API:      $NUMERIKA_API_URL"
echo " Model:    litellm/$MODEL"
echo " Postgres: $PG_URL"
echo "=============================================="
