// WorkspaceLifecycle — extracted from Orchestrator
// Manages workspace creation, cleanup, and termination of running issues.

import type { OrchestratorState, RunningEntry, ServiceConfig } from '../types.js';
import { logger } from '../observability/logger.js';
import { removeWorkspace } from '../workspace/manager.js';
import { sanitizeKey } from '../workspace/safety.js';

export class WorkspaceLifecycle {
  // ── Public API ──

  /**
   * Terminate a running issue: abort its process, optionally clean up its
   * workspace, and remove it from running/claimed/retry maps.
   * Returns the updated state.
   */
  async terminateAndClean(
    state: OrchestratorState,
    issueId: string,
    config: ServiceConfig,
    cleanupWorkspace: boolean,
  ): Promise<OrchestratorState> {
    const entry = state.running.get(issueId);
    if (!entry) {
      return this.releaseIssueClaim(state, issueId);
    }

    entry.abortController.abort();

    if (cleanupWorkspace) {
      await this.removeWorkspaceForEntry(entry, config);
    }

    const state2 = this.recordSessionCompletionTotals(state, entry);
    state2.running.delete(issueId);
    state2.claimed.delete(issueId);
    state2.retryAttempts.delete(issueId);
    return state2;
  }

  /**
   * Remove workspace for an issue identified by its identifier string.
   * Used when the issue is in a terminal state and workspace needs cleanup.
   */
  async removeWorkspaceByIdentifier(
    identifier: string,
    config: ServiceConfig,
  ): Promise<void> {
    const workspaceKey = sanitizeKey(identifier);
    const workspacePath = `${config.workspace.root}/${workspaceKey}`;
    await removeWorkspace(workspacePath, config);
  }

  // ── Internal helpers ──

  private async removeWorkspaceForEntry(
    entry: RunningEntry,
    config: ServiceConfig,
  ): Promise<void> {
    const workspaceKey = sanitizeKey(entry.identifier);
    const workspacePath = `${config.workspace.root}/${workspaceKey}`;
    try {
      await removeWorkspace(workspacePath, config);
    } catch (err) {
      logger.warn('Failed to cleanup workspace', { issue_id: entry.issueId, error: String(err) });
    }
  }

  private releaseIssueClaim(state: OrchestratorState, issueId: string): OrchestratorState {
    state.claimed.delete(issueId);
    state.retryAttempts.delete(issueId);
    return state;
  }

  private recordSessionCompletionTotals(
    state: OrchestratorState,
    entry: RunningEntry,
  ): OrchestratorState {
    const runtimeSeconds = (Date.now() - entry.startedAt.getTime()) / 1000;
    return {
      ...state,
      codexTotals: {
        ...state.codexTotals,
        secondsRunning: Math.max(0, state.codexTotals.secondsRunning + runtimeSeconds),
      },
    };
  }
}
