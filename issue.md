## [2026-05-31] Fix error_max_turns handling and tracker completion write-back

**Problem 1 (P0)**: `result_error?` in Claude CLI didn't explicitly handle `error_max_turns` subtype. When Claude hit `--max-turns`, the result event was treated as an implicit non-error because the subtype wasn't in the explicit error list. Token data was extracted but the flow was fragile and hard to reason about.

**Fix**: Rewrote `result_error?` with explicit `case` for `error_max_turns` (non-fatal soft completion), `error`/`error_tool_use` (genuine errors), and fallback. Added visibility logging in `handle_result_event` for max_turns events showing token count and cost.

**Problem 2 (P1)**: `update_tracker_completion` in the orchestrator unconditionally set tracker state to "Resolved" when the agent exited normally. This was wrong when the agent hit max_turns — the task wasn't actually resolved, but the Bitable record was marked as Resolved, causing the continuation retry to find a terminal state and give up. Additionally, `update_record_with_metadata` in the Bitable adapter had no error logging.

**Fix**: Replaced `update_tracker_completion` with `update_tracker_token_metadata` that writes token/retry/branch metadata WITHOUT changing the issue state. The continuation retry now properly checks the actual issue state and either re-dispatches (still active) or cleans up (genuinely resolved). Added debug/info/warning logging to `update_record_with_metadata` for all Bitable write outcomes.

**Problem 3 (P2)**: Logger already writes to file — `LogFile.configure()` is called at OTP Application startup and removes the default console handler. No changes needed.

**Files changed**: `elixir/lib/symphony_elixir/claude/cli.ex`, `elixir/lib/symphony_elixir/orchestrator.ex`, `elixir/lib/symphony_elixir/feishu/bitable/adapter.ex`

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
[AI-REVIEW] Large commit detected: 544 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 459 lines added. Consider reviewing for AI Psychosis.
