[AI-REVIEW] Large commit detected: 849487 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 232 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 1541 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 1545 lines added. Consider reviewing for AI Psychosis.

## [2026-05-29] Hook timeout: process-group-level cleanup

**Problem**: `runHook()` used Node's `spawn` `timeout` option, which sends SIGTERM to the bash process only. When `bash -lc` execs into another program (e.g., `git clone`), the child becomes an orphan on macOS.

**Fix**: Replaced with manual process-group management:
- `detached: true` spawns child in its own process group
- Timeout sends SIGTERM to the whole group via `process.kill(-pid, 'SIGTERM')`
- 2s grace period then SIGKILL to the group
- Normal exit also kills the group to clean up lingering children
- New error kind `hook_timeout` distinguishes timeout from other failures

**Files changed**: `typescript/src/workspace/hooks.ts`, `typescript/test/hooks.test.ts`

## [2026-05-29] Add Claude Code CLI as alternative agent backend

**Problem**: Symphony only supported OpenAI Codex via JSON-RPC app-server protocol. No way to use Claude Code as the coding agent.

**Solution**: Introduced a pluggable `AgentAdapter` interface with two implementations:
- `CodexAdapter` — wraps existing app-server.ts (zero changes to Codex code)
- `ClaudeAdapter` — spawns `claude -p` as subprocess per turn, uses `--resume` for multi-turn continuity, parses `--output-format stream-json` output

**Architecture**:
- `AgentAdapter` interface: `startSession` / `runTurn` / `stopSession`
- `createAdapter(kind)` factory selects adapter based on `agent.kind` config
- Config: `agent.kind: 'codex' | 'claude'` (defaults to `'codex'` for backward compat)
- New `claude` config section: command, model, maxTurnsPerInvocation, skipPermissions, systemPrompt, timeouts
- Runner uses adapter generically; orchestrator stall detection reads agent-specific timeout

**Files created**: `adapter.ts`, `claude-adapter.ts`, `codex-adapter.ts`, `claude-adapter.test.ts`
**Files modified**: `types.ts`, `config/index.ts`, `runner.ts`, `orchestrator/index.ts`, `index.ts`, `test/helpers.ts`
**Tests**: 179 passed (13 new Claude adapter tests), zero regressions
[AI-REVIEW] Large commit detected: 345 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 749 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 865 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 318 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 319 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 320 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 321 lines added. Consider reviewing for AI Psychosis.
