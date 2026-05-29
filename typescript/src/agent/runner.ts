import type { Issue, ServiceConfig, Result, CodexUpdateEvent } from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';
import { startSession, runTurn, stopSession, type Session } from './app-server.js';

// ── Dependencies injected from existing modules ──

export interface RunnerDependencies {
  createForIssue: (identifier: string, config: ServiceConfig) => Promise<Result<{ path: string; workspaceKey: string; createdNow: boolean }>>;
  runHook: (script: string, workspacePath: string, hookName: string, timeoutMs: number) => Promise<Result<void>>;
  buildPrompt: (issue: Issue, attempt: number | null, template: string) => Result<string>;
  fetchIssueStatesByIds: (ids: string[], config: ServiceConfig) => Promise<Result<Issue[]>>;
  getPromptTemplate: () => string;
}

// ── runAgent ──

export async function runAgent(
  issue: Issue,
  attempt: number | null,
  config: ServiceConfig,
  onMessage: (event: CodexUpdateEvent) => void,
  abortSignal: AbortSignal,
  deps: RunnerDependencies,
): Promise<Result<void>> {
  const logCtx = { issue_id: issue.id, issue_identifier: issue.identifier };

  // ── create/reuse workspace ──

  const wsResult = await deps.createForIssue(issue.identifier, config);
  if (!wsResult.ok) {
    return { ok: false, error: new TypedError('workspace_creation_error', `workspace creation failed: ${wsResult.error.message}`, wsResult.error) };
  }
  const workspace = wsResult.value.path;

  logger.info('Workspace ready', { ...logCtx, workspace });

  // ── beforeRun hook ──

  if (config.hooks.beforeRun) {
    const hookResult = await deps.runHook(config.hooks.beforeRun, workspace, 'beforeRun', config.hooks.timeoutMs);
    if (!hookResult.ok) {
      return { ok: false, error: new TypedError('hook_failed', `beforeRun hook failed: ${hookResult.error.message}`, hookResult.error) };
    }
  }

  // ── start app-server session ──

  const sessionResult = await startSession(workspace, config);
  if (!sessionResult.ok) {
    await afterRunBestEffort(deps, workspace, issue, config);
    return { ok: false, error: new TypedError('spawn_failed', `failed to start codex session: ${sessionResult.error.message}`, sessionResult.error) };
  }

  const session = sessionResult.value;

  try {
    // ── turn loop ──

    const maxTurns = config.agent.maxTurns;
    let turnNumber = 1;
    let currentIssue = issue;

    while (turnNumber <= maxTurns) {
      if (abortSignal.aborted) {
        return { ok: false, error: new TypedError('turn_cancelled', 'aborted by signal') };
      }

      const promptResult = buildTurnPrompt(deps, currentIssue, attempt, turnNumber, maxTurns);
      if (!promptResult.ok) {
        return { ok: false, error: promptResult.error };
      }

      logger.info('Starting turn', { ...logCtx, turn: turnNumber, max_turns: maxTurns });

      const turnResult = await runTurn(session, promptResult.value, currentIssue, config, onMessage);

      if (!turnResult.ok) {
        logger.warn('Turn failed', { ...logCtx, turn: turnNumber, error: turnResult.error.message });
        return { ok: false, error: turnResult.error };
      }

      logger.info('Turn completed', { ...logCtx, turn: turnNumber, max_turns: maxTurns });

      // ── refresh issue state ──

      const refreshResult = await deps.fetchIssueStatesByIds([currentIssue.id], config);
      if (!refreshResult.ok) {
        logger.warn('Failed to refresh issue state, continuing', { ...logCtx, error: refreshResult.error.message });
      } else if (refreshResult.value.length > 0) {
        currentIssue = refreshResult.value[0];
        if (!isActiveState(currentIssue.state, config)) {
          logger.info('Issue no longer active, stopping', { ...logCtx, state: currentIssue.state });
          return { ok: true, value: undefined };
        }
      } else {
        logger.info('Issue not found in tracker, stopping', logCtx);
        return { ok: true, value: undefined };
      }

      if (turnNumber >= maxTurns) {
        logger.info('Reached max turns with issue still active', { ...logCtx, max_turns: maxTurns });
        return { ok: true, value: undefined };
      }

      turnNumber++;
    }
  } finally {
    stopSession(session);
    await afterRunBestEffort(deps, workspace, issue, config);
  }

  return { ok: true, value: undefined };
}

// ── buildTurnPrompt ──

function buildTurnPrompt(
  deps: RunnerDependencies,
  issue: Issue,
  attempt: number | null,
  turnNumber: number,
  maxTurns: number,
): Result<string> {
  if (turnNumber === 1) {
    return deps.buildPrompt(issue, attempt, deps.getPromptTemplate());
  }

  return {
    ok: true,
    value: [
      'Continuation guidance:',
      '',
      '- The previous Codex turn completed normally, but the issue is still in an active state.',
      `- This is continuation turn #${turnNumber} of ${maxTurns} for the current agent run.`,
      '- Resume from the current workspace and workpad state instead of restarting from scratch.',
      '- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.',
      '- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.',
    ].join('\n'),
  };
}

// ── helpers ──

function isActiveState(state: string, config: ServiceConfig): boolean {
  const normalized = state.trim().toLowerCase();
  return config.tracker.activeStates.some((s) => s.trim().toLowerCase() === normalized);
}

async function afterRunBestEffort(
  deps: RunnerDependencies,
  workspace: string,
  issue: Issue,
  config: ServiceConfig,
): Promise<void> {
  if (!config.hooks.afterRun) return;
  try {
    const result = await deps.runHook(config.hooks.afterRun, workspace, 'afterRun', config.hooks.timeoutMs);
    if (!result.ok) {
      logger.debug('afterRun hook failed (best-effort)', { error: result.error.message });
    }
  } catch (err) {
    logger.debug('afterRun hook threw (best-effort)', { error: String(err) });
  }
}
