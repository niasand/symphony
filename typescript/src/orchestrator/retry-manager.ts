// RetryManager — extracted from Orchestrator
// Manages retry scheduling, delay calculation, and retry entry lifecycle.

import type { OrchestratorState, RetryEntry, ServiceConfig } from '../types.js';
import { logger } from '../observability/logger.js';

export const CONTINUATION_RETRY_DELAY_MS = 1000;
export const FAILURE_RETRY_BASE_MS = 10000;

export interface RetryMetadata {
  identifier?: string;
  error?: string;
  delayType?: 'continuation';
  workerHost?: string;
  workspacePath?: string;
}

/**
 * Callback invoked when a retry timer fires.
 * The owner (Orchestrator) supplies this to wire retry handling back
 * into the dispatch / state-management loop.
 */
export type RetryDueCallback = (issueId: string, retryToken: symbol) => void;

export class RetryManager {
  private retryDueCallback: RetryDueCallback;

  constructor(retryDueCallback: RetryDueCallback) {
    this.retryDueCallback = retryDueCallback;
  }

  // ── Public API ──

  /** Schedule a retry entry, returning the updated state. */
  schedule(
    state: OrchestratorState,
    issueId: string,
    attempt: number | null,
    metadata: RetryMetadata,
    maxRetryBackoffMs: number,
  ): OrchestratorState {
    const previous = state.retryAttempts.get(issueId);
    const nextAttempt = attempt ?? ((previous?.attempt ?? 0) + 1);
    const delayMs = this.retryDelay(nextAttempt, metadata, maxRetryBackoffMs);
    const retryToken = Symbol('retry');
    const dueAtMs = Date.now() + delayMs;

    if (previous?.timerHandle) {
      clearTimeout(previous.timerHandle);
    }

    const timerHandle = setTimeout(() => {
      this.retryDueCallback(issueId, retryToken);
    }, delayMs);

    if (timerHandle.unref) timerHandle.unref();

    const identifier = metadata.identifier ?? previous?.identifier ?? issueId;
    const error = metadata.error ?? previous?.error ?? null;

    logger.info('Scheduling retry', {
      issue_id: issueId,
      issue_identifier: identifier,
      delay_ms: delayMs,
      attempt: nextAttempt,
      error: error ?? undefined,
    });

    state.retryAttempts.set(issueId, {
      issueId,
      identifier,
      attempt: nextAttempt,
      dueAtMs,
      timerHandle,
      retryToken,
      error,
      workerHost: metadata.workerHost ?? previous?.workerHost ?? null,
      workspacePath: metadata.workspacePath ?? previous?.workspacePath ?? null,
    });

    return state;
  }

  /** Remove and return a due retry entry if its token matches. */
  claimDueEntry(state: OrchestratorState, issueId: string, retryToken: symbol): RetryEntry | null {
    const retry = state.retryAttempts.get(issueId);
    if (!retry || retry.retryToken !== retryToken) return null;
    state.retryAttempts.delete(issueId);
    return retry;
  }

  /** Cancel all retry timers and clear the map. */
  cancelAll(state: OrchestratorState): void {
    for (const [, entry] of state.retryAttempts) {
      if (entry.timerHandle) clearTimeout(entry.timerHandle);
    }
    state.retryAttempts.clear();
  }

  /** Cancel a single retry entry by issue ID. */
  cancel(state: OrchestratorState, issueId: string): void {
    const entry = state.retryAttempts.get(issueId);
    if (entry?.timerHandle) clearTimeout(entry.timerHandle);
    state.retryAttempts.delete(issueId);
  }

  /** Get a snapshot of all retry entries. */
  getEntries(state: OrchestratorState): Map<string, RetryEntry> {
    return state.retryAttempts;
  }

  /** Check if an issue has a pending retry. */
  has(state: OrchestratorState, issueId: string): boolean {
    return state.retryAttempts.has(issueId);
  }

  // ── Delay calculation ──

  private retryDelay(attempt: number, metadata: RetryMetadata, maxRetryBackoffMs: number): number {
    if (metadata.delayType === 'continuation' && attempt === 1) {
      return CONTINUATION_RETRY_DELAY_MS;
    }
    const maxPower = Math.min(attempt - 1, 10);
    return Math.min(FAILURE_RETRY_BASE_MS * (1 << maxPower), maxRetryBackoffMs);
  }
}
