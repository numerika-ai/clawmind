#!/bin/bash
# =============================================================================
# install-macos.sh — Install memory-unified + openclaw on macOS (Mac Mini)
#
# Prerequisites: macOS with Homebrew installed
# Usage: curl -fsSL https://raw.githubusercontent.com/numerika-ai/clawmind/main/scripts/install-macos.sh | bash
# =============================================================================

set -euo pipefail

echo "=============================================="
echo " memory-unified + openclaw — macOS installer"
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
  echo "  bash install-macos.sh"
  exit 1
fi

echo ""
echo "API:   $NUMERIKA_API_URL"
echo "Model: $MODEL"
echo "DB:    $PG_DB"
echo ""

# 1. Node.js
echo ">>> [1/8] Node.js..."
if ! command -v node &>/dev/null; then
  brew install node@22
  echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
fi
echo "  node $(node --version)"

# 2. PostgreSQL + pgvector
echo ">>> [2/8] PostgreSQL + pgvector..."
if ! command -v psql &>/dev/null; then
  brew install postgresql@16
fi
brew services start postgresql@16 2>/dev/null || true

if ! brew list pgvector &>/dev/null; then
  brew install pgvector
fi

# Create user + database
psql postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='$PG_USER'" | grep -q 1 || \
  psql postgres -c "CREATE USER $PG_USER WITH PASSWORD '$PG_PASS';"
psql postgres -tc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 || \
  psql postgres -c "CREATE DATABASE $PG_DB OWNER $PG_USER;"
psql -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || \
  psql -U postgres -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;"

PG_URL="postgresql://$PG_USER:$PG_PASS@localhost:5432/$PG_DB"
echo "  postgres: $PG_URL"

# 3. openclaw
echo ">>> [3/8] openclaw..."
if ! command -v openclaw &>/dev/null; then
  npm install -g openclaw
fi
echo "  openclaw $(openclaw --version 2>/dev/null || echo 'installed')"

# 4. memory-unified plugin
echo ">>> [4/8] memory-unified plugin..."
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

# 5. Apply schema migrations
echo ">>> [5/8] Database schema..."
for sql in schema/*.sql; do
  if [ -f "$sql" ]; then
    PGPASSWORD="$PG_PASS" psql -h localhost -U "$PG_USER" -d "$PG_DB" -f "$sql" 2>/dev/null || true
    echo "  applied: $sql"
  fi
done

# Also apply unified-memory schemas if present
UM_SCHEMA_DIR="$HOME/.openclaw/extensions/unified-memory/schema"
if [ -d "$UM_SCHEMA_DIR" ]; then
  for sql in "$UM_SCHEMA_DIR"/*.sql; do
    PGPASSWORD="$PG_PASS" psql -h localhost -U "$PG_USER" -d "$PG_DB" -f "$sql" 2>/dev/null || true
    echo "  applied: $sql"
  done
fi

# 6. openclaw onboard with LiteLLM
echo ">>> [6/8] openclaw config..."
mkdir -p "$HOME/.openclaw"

# Check if openclaw.json exists
if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
  export LITELLM_API_KEY="$NUMERIKA_API_KEY"
  openclaw onboard --auth-choice litellm-api-key --non-interactive 2>/dev/null || true
fi

# 7. Inject memory-unified plugin config
echo ">>> [7/8] Plugin config..."
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
        'rerankUrl': '$NUMERIKA_API_URL/rerank',
        'rerankEnabled': False,
        'ragSlim': True,
        'ragTopK': 5,
        'logToolCalls': True,
        'logToolCallsFilter': 'whitelist',
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

# Ensure LiteLLM provider
cfg.setdefault('models', {}).setdefault('providers', {})
cfg['models']['providers']['litellm'] = {
    'baseUrl': '$NUMERIKA_API_URL',
    'apiKey': '$NUMERIKA_API_KEY',
    'api': 'openai-completions',
    'models': [
        {
            'id': 'qwen3.5-397b-thinking',
            'name': 'Qwen 3.5 397B (thinking)',
            'reasoning': True,
            'input': ['text'],
            'contextWindow': 199000,
            'maxTokens': 16384
        },
        {
            'id': 'qwen3.5-397b',
            'name': 'Qwen 3.5 397B',
            'reasoning': True,
            'input': ['text'],
            'contextWindow': 199000,
            'maxTokens': 16384
        },
        {
            'id': 'gemini-3.1-pro',
            'name': 'Gemini 3.1 Pro',
            'reasoning': True,
            'input': ['text'],
            'contextWindow': 1048576,
            'maxTokens': 32768
        }
    ]
}

cfg.setdefault('agents', {}).setdefault('defaults', {})
cfg['agents']['defaults']['model'] = {
    'primary': 'litellm/$MODEL',
    'fallbacks': ['litellm/gemini-3.1-pro']
}

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)

print('  config written to', config_path)
"

# 8. Verify
echo ">>> [8/8] Verification..."
echo "  Testing API connectivity..."
EMBED_TEST=$(curl -s --max-time 10 -H "Authorization: Bearer $NUMERIKA_API_KEY" \
  -H "Content-Type: application/json" \
  "$NUMERIKA_API_URL/v1/embeddings" \
  -d "{\"model\":\"qwen3-embedding-8b\",\"input\":\"test\"}" 2>&1 | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    e=d.get('data',[{}])[0].get('embedding',[])
    print(f'OK (dim={len(e)})')
except:
    print('FAIL')
" 2>&1)
echo "  embedding: $EMBED_TEST"

CHAT_TEST=$(curl -s --max-time 15 -H "Authorization: Bearer $NUMERIKA_API_KEY" \
  -H "Content-Type: application/json" \
  "$NUMERIKA_API_URL/v1/chat/completions" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_tokens\":5}" 2>&1 | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('OK') if 'choices' in d else print('FAIL:', json.dumps(d)[:100])
except:
    print('FAIL')
" 2>&1)
echo "  chat: $CHAT_TEST"

PG_TEST=$(PGPASSWORD="$PG_PASS" psql -h localhost -U "$PG_USER" -d "$PG_DB" -tc "SELECT 'OK';" 2>&1 | tr -d ' ')
echo "  postgres: $PG_TEST"

echo ""
echo "=============================================="
echo " DONE! Start openclaw:"
echo ""
echo "   openclaw"
echo ""
echo " API:      $NUMERIKA_API_URL"
echo " Model:    litellm/$MODEL"
echo " Postgres: $PG_URL"
echo " Plugin:   $PLUGIN_DIR"
echo "=============================================="
