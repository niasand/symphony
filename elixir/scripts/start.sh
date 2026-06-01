#!/bin/bash
# Symphony startup script for pm2
cd "$(dirname "$0")/.."

# Load secrets from .env (never commit secrets to git)
set -a
source "$(dirname "$0")/../.env"
set +a

# Feishu webhook for task completion notifications
if [ -n "$FEISHU_WEBHOOK_URL" ]; then
  export FEISHU_WEBHOOK_URL
fi

eval "$(mise activate bash)"
mix run --no-halt
