#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hook_path="$repo_root/.git/hooks/pre-commit"

mkdir -p "$(dirname "$hook_path")"

cat >"$hook_path" <<'HOOK'
#!/usr/bin/env bash
# pre-commit hook: scan staged files for secrets with gitleaks
# Install: scripts/install-git-hooks.sh

set -eo pipefail

if ! command -v gitleaks &>/dev/null; then
  echo "⚠️  gitleaks not installed — skipping secret scan. Run: brew install gitleaks"
  exit 0
fi

# gitleaks git --staged scans only staged changes, returns 1 if leaks found
if ! gitleaks git --staged --redact --config="$(git rev-parse --show-toplevel)/.gitleaks.toml" 2>/dev/null; then
  echo ""
  echo "❌ Secret detected in staged files! Commit aborted."
  echo "   If this is a false positive, inspect the finding before using: git commit --no-verify"
  exit 1
fi
HOOK

chmod +x "$hook_path"
echo "Installed pre-commit hook at $hook_path"
