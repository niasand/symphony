#!/bin/bash
# Symphony startup script for pm2
cd "$(dirname "$0")/.."

export FEISHU_APP_ID="cli_a94c29994e381cd4"
export FEISHU_APP_SECRET="LSHhJaYGeMB5j6afrO4WafTxst2VgBUC"
export FEISHU_BITABLE_APP_TOKEN="Ir7pbRChgaYRYns4hmWcNfHJnKe"
export FEISHU_BITABLE_TABLE_ID="tblHW47GcJNC0SqE"

eval "$(mise activate bash)"
mix run --no-halt 2>&1 | tee -a logs/debug.log
