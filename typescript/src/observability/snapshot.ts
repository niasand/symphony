// Snapshot builder — Spec Section 13.3, 13.7.2

import type { OrchestratorState, RuntimeSnapshot, RunningSessionRow, RetryQueueRow } from '../types.js';

export function buildSnapshot(state: OrchestratorState): RuntimeSnapshot {
  const now = new Date();
  const nowMs = Date.now();

  const running: RunningSessionRow[] = [...state.running.entries()].map(([, entry]) => ({
    issue_id: entry.issueId,
    issue_identifier: entry.identifier,
    state: entry.issue.state,
    session_id: entry.sessionId,
    turn_count: entry.turnCount,
    last_event: entry.lastCodexEvent,
    last_message: entry.lastCodexMessage,
    started_at: entry.startedAt.toISOString(),
    last_event_at: entry.lastCodexTimestamp?.toISOString() ?? null,
    tokens: {
      input_tokens: entry.codexInputTokens,
      output_tokens: entry.codexOutputTokens,
      total_tokens: entry.codexTotalTokens,
    },
    worker_host: entry.workerHost,
  }));

  const retrying: RetryQueueRow[] = [...state.retryAttempts.entries()].map(([, retry]) => ({
    issue_id: retry.issueId,
    issue_identifier: retry.identifier,
    attempt: retry.attempt,
    due_at: new Date(retry.dueAtMs).toISOString(),
    error: retry.error,
  }));

  let activeSeconds = 0;
  for (const [, entry] of state.running) {
    activeSeconds += (now.getTime() - entry.startedAt.getTime()) / 1000;
  }

  return {
    generated_at: now.toISOString(),
    counts: {
      running: state.running.size,
      retrying: state.retryAttempts.size,
    },
    running,
    retrying,
    codex_totals: {
      ...state.codexTotals,
      seconds_running: state.codexTotals.secondsRunning + activeSeconds,
    },
    rate_limits: state.codexRateLimits,
  };
}
