#!/usr/bin/env bash
# Symphony miniagent Orchestrator daemon wrapper.
# Same as symphony-daemon.sh but uses WORKFLOW-miniagent.md and port 3103.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ELIXIR_DIR="$PROJECT_ROOT/elixir"
ENV_FILE="$ELIXIR_DIR/.env"

# ── Load environment variables from .env ──
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    export "$key=$value"
  done < "$ENV_FILE"
else
  echo "ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

# ── Ensure required env vars are set ──
for var in FEISHU_APP_ID FEISHU_APP_SECRET; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set" >&2
    exit 1
  fi
done

# ── Inject mise-managed Elixir/Erlang into PATH ──
MISE_ROOT="$HOME/.local/share/mise"
ERL_DIR="$MISE_ROOT/installs/erlang/28/bin"
EX_DIR="$MISE_ROOT/installs/elixir/1.19.5-otp-28/bin"
export PATH="$EX_DIR:$ERL_DIR:$PATH"

# ── Ensure logs directory exists ──
mkdir -p "$ELIXIR_DIR/logs"

# ── Start orchestrator with miniagent workflow ──
cd "$ELIXIR_DIR"
exec "$ELIXIR_DIR/bin/symphony" \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails \
  --port 3103 \
  "$ELIXIR_DIR/WORKFLOW-miniagent.md"
