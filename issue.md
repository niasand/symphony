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
[AI-REVIEW] Large commit detected: 345 lines added. Consider reviewing for AI Psychosis.
[AI-REVIEW] Large commit detected: 749 lines added. Consider reviewing for AI Psychosis.
