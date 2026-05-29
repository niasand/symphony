// Orchestrator — Spec Section 7, 8, 16
// Thin coordinator: owns EventEmitter, state, tick loop timing, and reconciliation.
// Delegates to RetryManager, WorkspaceLifecycle, DispatchScheduler.

import { EventEmitter } from 'node:events';
import type {
  Result, ServiceConfig, Issue, OrchestratorState, RunningEntry,
  RetryEntry, CodexUpdateEvent, CodexTotals, RuntimeSnapshot,
  RunningSessionRow, RetryQueueRow, WorkerExitReason,
} from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';
import { fetchCandidateIssues, fetchIssueStatesByIds, fetchIssuesByStates } from '../tracker/client.js';
import { validateDispatchConfig } from '../config/index.js';
import { sanitizeKey } from '../workspace/safety.js';
import { removeWorkspace } from '../workspace/manager.js';
import { RetryManager } from './retry-manager.js';
import { WorkspaceLifecycle } from './workspace-lifecycle.js';
import { DispatchScheduler } from './dispatch-scheduler.js';

const EMPTY_CODEX_TOTALS: CodexTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  secondsRunning: 0,
};

type OrchestratorEventMap = {
  update: [];
  error: [error: TypedError];
};

export class Orchestrator extends EventEmitter<OrchestratorEventMap> {
  private state: OrchestratorState;
  private config: ServiceConfig;
  private tickTimer: NodeJS.Timeout | null = null;
  private tickToken: symbol | null = null;
  private pollCheckInProgress = false;
  private nextPollDueAtMs: number | null = null;
  private workerRunFn: (issue: Issue, attempt: number | null, config: ServiceConfig, onMessage: (event: CodexUpdateEvent) => void, signal: AbortSignal) => Promise<Result<void>>;

  // Extracted collaborators
  private retryManager: RetryManager;
  private workspaceLifecycle: WorkspaceLifecycle;
  private dispatchScheduler: DispatchScheduler;

  constructor(
    workflowPath: string,
    config: ServiceConfig,
    workerRunFn: Orchestrator['workerRunFn'],
  ) {
    super();
    this.config = config;
    this.workerRunFn = workerRunFn;
    this.state = {
      pollIntervalMs: config.polling.intervalMs,
      maxConcurrentAgents: config.agent.maxConcurrentAgents,
      running: new Map(),
      claimed: new Set(),
      retryAttempts: new Map(),
      completed: new Set(),
      codexTotals: { ...EMPTY_CODEX_TOTALS },
      codexRateLimits: null,
    };

    // Wire collaborators
    this.retryManager = new RetryManager((issueId, retryToken) => {
      this.handleRetry(issueId, retryToken);
    });
    this.workspaceLifecycle = new WorkspaceLifecycle();
    this.dispatchScheduler = new DispatchScheduler();
  }

  // ── Lifecycle ──

  start(): void {
    this.runStartupTerminalCleanup();
    this.scheduleTick(0);
    logger.info('Orchestrator started');
  }

  stop(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
      this.tickToken = null;
    }
    this.retryManager.cancelAll(this.state);
    for (const [issueId, entry] of this.state.running) {
      entry.abortController.abort();
      logger.info('Aborting running agent', { issue_id: issueId, issue_identifier: entry.identifier });
    }
    logger.info('Orchestrator stopped');
  }

  updateConfig(config: ServiceConfig): void {
    this.config = config;
    this.state.pollIntervalMs = config.polling.intervalMs;
    this.state.maxConcurrentAgents = config.agent.maxConcurrentAgents;
    logger.info('Orchestrator config updated', {
      poll_interval_ms: config.polling.intervalMs,
      max_concurrent_agents: config.agent.maxConcurrentAgents,
    });
  }

  // ── Tick scheduling ──

  private scheduleTick(delayMs: number): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    const token = Symbol('tick');
    this.tickToken = token;
    this.nextPollDueAtMs = Date.now() + delayMs;

    this.tickTimer = setTimeout(() => {
      if (this.tickToken !== token) return;
      this.tickToken = null;
      this.tickTimer = null;
      this.pollCheckInProgress = true;
      this.nextPollDueAtMs = null;
      this.emit('update');
      setImmediate(() => this.runPollCycle());
    }, delayMs);

    if (this.tickTimer.unref) {
      this.tickTimer.unref();
    }
  }

  private async runPollCycle(): Promise<void> {
    await this.maybeDispatch();
    this.pollCheckInProgress = false;
    this.scheduleTick(this.state.pollIntervalMs);
    this.emit('update');
  }

  // ── Dispatch ──

  private async maybeDispatch(): Promise<void> {
    this.state = await this.reconcileRunningIssues();
    this.state = this.reconcileBlockedIssues();

    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      logger.error('Dispatch validation failed', { error: validation.error.message });
      this.emit('error', validation.error);
      return;
    }

    const issuesResult = await fetchCandidateIssues(this.config);
    if (!issuesResult.ok) {
      logger.error('Failed to fetch candidate issues', { error: issuesResult.error.message });
      return;
    }

    if (this.dispatchScheduler.availableSlots(this.state) <= 0) return;

    this.chooseIssues(issuesResult.value);
  }

  private chooseIssues(issues: Issue[]): void {
    const sorted = this.sortIssuesForDispatch(issues);
    for (const issue of sorted) {
      if (this.dispatchScheduler.availableSlots(this.state) <= 0) break;
      if (this.shouldDispatchIssue(issue)) {
        this.dispatchIssue(issue, null);
      }
    }
  }

  // ── Public delegation methods (preserve existing API) ──

  sortIssuesForDispatch(issues: Issue[]): Issue[] {
    return this.dispatchScheduler.sortCandidates(issues);
  }

  shouldDispatchIssue(issue: Issue): boolean {
    return this.dispatchScheduler.shouldDispatch(issue, this.state, this.config);
  }

  // ── Dispatch one issue ──

  dispatchIssue(issue: Issue, attempt: number | null): void {
    logger.info('Dispatching issue to agent', {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: attempt ?? 'null',
    });

    const abortController = new AbortController();
    const issueId = issue.id;

    const runningEntry: RunningEntry = {
      issueId,
      identifier: issue.identifier,
      issue,
      retryAttempt: attempt != null && attempt > 0 ? attempt : 0,
      startedAt: new Date(),
      workerHost: null,
      workspacePath: null,
      abortController,
      sessionId: null,
      threadId: null,
      turnId: null,
      codexAppServerPid: null,
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: '',
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
      lastReportedInputTokens: 0,
      lastReportedOutputTokens: 0,
      lastReportedTotalTokens: 0,
      turnCount: 0,
    };

    this.state.running.set(issueId, runningEntry);
    this.state.claimed.add(issueId);
    this.state.retryAttempts.delete(issueId);

    this.workerRunFn(issue, attempt, this.config, this.handleCodexUpdate.bind(this, issueId), abortController.signal)
      .then(() => {
        this.handleWorkerExit(issueId, 'normal');
      })
      .catch((err: unknown) => {
        this.handleWorkerExit(issueId, 'abnormal', err instanceof Error ? err.message : String(err));
      });
  }

  // ── Worker exit ──

  private handleWorkerExit(issueId: string, reason: WorkerExitReason, errorMsg?: string): void {
    const runningEntry = this.state.running.get(issueId);
    if (!runningEntry) return;

    this.state.running.delete(issueId);
    this.state = this.recordSessionCompletionTotals(this.state, runningEntry);

    const sessionId = runningEntry.sessionId ?? 'n/a';

    if (reason === 'normal') {
      logger.info('Agent task completed', { issue_id: issueId, session_id: sessionId });
      this.state.completed.add(issueId);
      this.state = this.retryManager.schedule(this.state, issueId, 1, {
        identifier: runningEntry.identifier,
        delayType: 'continuation',
      }, this.config.agent.maxRetryBackoffMs);
    } else {
      logger.warn('Agent task exited', { issue_id: issueId, session_id: sessionId, error: errorMsg });
      const nextAttempt = runningEntry.retryAttempt > 0 ? runningEntry.retryAttempt + 1 : 1;
      this.state = this.retryManager.schedule(this.state, issueId, nextAttempt, {
        identifier: runningEntry.identifier,
        error: errorMsg ?? 'agent exited abnormally',
      }, this.config.agent.maxRetryBackoffMs);
    }

    this.emit('update');
  }

  // ── Codex update handling ──

  handleCodexUpdate(issueId: string, update: CodexUpdateEvent): void {
    const runningEntry = this.state.running.get(issueId);
    if (!runningEntry) return;

    const { updated, tokenDelta } = this.integrateCodexUpdate(runningEntry, update);
    this.state.running.set(issueId, updated);
    this.state = this.applyCodexTokenDelta(this.state, tokenDelta);
    this.state = this.applyCodexRateLimits(this.state, update);
    this.emit('update');
  }

  private integrateCodexUpdate(
    entry: RunningEntry,
    update: CodexUpdateEvent,
  ): { updated: RunningEntry; tokenDelta: { inputTokens: number; outputTokens: number; totalTokens: number } } {
    const tokenDelta = this.extractTokenDelta(entry, update);

    const updated: RunningEntry = {
      ...entry,
      lastCodexTimestamp: update.timestamp,
      lastCodexMessage: update.message ?? '',
      lastCodexEvent: update.event,
      codexAppServerPid: update.codexAppServerPid ?? entry.codexAppServerPid,
      codexInputTokens: entry.codexInputTokens + tokenDelta.inputTokens,
      codexOutputTokens: entry.codexOutputTokens + tokenDelta.outputTokens,
      codexTotalTokens: entry.codexTotalTokens + tokenDelta.totalTokens,
      lastReportedInputTokens: Math.max(entry.lastReportedInputTokens, tokenDelta.inputTokens),
      lastReportedOutputTokens: Math.max(entry.lastReportedOutputTokens, tokenDelta.outputTokens),
      lastReportedTotalTokens: Math.max(entry.lastReportedTotalTokens, tokenDelta.totalTokens),
    };

    if (update.event === 'session_started' && update.payload?.session_id) {
      const newSessionId = String(update.payload.session_id);
      if (newSessionId !== entry.sessionId) {
        updated.sessionId = newSessionId;
        updated.turnCount = entry.turnCount + 1;
      }
    }

    return { updated, tokenDelta };
  }

  private extractTokenDelta(
    entry: RunningEntry,
    update: CodexUpdateEvent,
  ): { inputTokens: number; outputTokens: number; totalTokens: number } {
    const usage = update.usage ?? {};
    const inputReported = usage.inputTokens ?? entry.lastReportedInputTokens;
    const outputReported = usage.outputTokens ?? entry.lastReportedOutputTokens;
    const totalReported = usage.totalTokens ?? entry.lastReportedTotalTokens;

    return {
      inputTokens: Math.max(inputReported - entry.lastReportedInputTokens, 0),
      outputTokens: Math.max(outputReported - entry.lastReportedOutputTokens, 0),
      totalTokens: Math.max(totalReported - entry.lastReportedTotalTokens, 0),
    };
  }

  private applyCodexTokenDelta(
    state: OrchestratorState,
    delta: { inputTokens: number; outputTokens: number; totalTokens: number },
  ): OrchestratorState {
    return {
      ...state,
      codexTotals: {
        inputTokens: Math.max(0, state.codexTotals.inputTokens + delta.inputTokens),
        outputTokens: Math.max(0, state.codexTotals.outputTokens + delta.outputTokens),
        totalTokens: Math.max(0, state.codexTotals.totalTokens + delta.totalTokens),
        secondsRunning: state.codexTotals.secondsRunning,
      },
    };
  }

  private applyCodexRateLimits(state: OrchestratorState, update: CodexUpdateEvent): OrchestratorState {
    const rl = (update.payload as Record<string, unknown>)?.rate_limits;
    if (rl && typeof rl === 'object') {
      return { ...state, codexRateLimits: rl as Record<string, unknown> };
    }
    return state;
  }

  private recordSessionCompletionTotals(state: OrchestratorState, entry: RunningEntry): OrchestratorState {
    const runtimeSeconds = (Date.now() - entry.startedAt.getTime()) / 1000;
    return {
      ...state,
      codexTotals: {
        ...state.codexTotals,
        secondsRunning: Math.max(0, state.codexTotals.secondsRunning + runtimeSeconds),
      },
    };
  }

  // ── Reconciliation ──

  private async reconcileRunningIssues(): Promise<OrchestratorState> {
    let state = await this.reconcileStalledRunningIssues();

    const runningIds = [...state.running.keys()];
    if (runningIds.length === 0) return state;

    return state;
  }

  async refreshRunningIssueStates(): Promise<void> {
    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;

    const result = await fetchIssueStatesByIds(runningIds, this.config);
    if (!result.ok) {
      logger.debug('Failed to refresh running issue states; keeping active workers', {
        error: result.error.message,
      });
      return;
    }

    const activeStates = this.activeStateSet();
    const terminalStates = this.terminalStateSet();
    const visibleIds = new Set<string>();

    for (const issue of result.value) {
      if (!issue.id) continue;
      visibleIds.add(issue.id);

      if (terminalStates.has(this.normalizeIssueState(issue.state))) {
        logger.info('Issue moved to terminal state; stopping agent', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
        await this.terminateRunningIssue(issue.id, true);
      } else if (activeStates.has(this.normalizeIssueState(issue.state))) {
        const entry = this.state.running.get(issue.id);
        if (entry) {
          this.state.running.set(issue.id, { ...entry, issue });
        }
      } else {
        logger.info('Issue moved to non-active state; stopping agent', {
          issue_id: issue.id,
          issue_identifier: issue.identifier,
          state: issue.state,
        });
        await this.terminateRunningIssue(issue.id, false);
      }
    }

    for (const issueId of runningIds) {
      if (!visibleIds.has(issueId)) {
        const entry = this.state.running.get(issueId);
        logger.info('Issue no longer visible; stopping agent', {
          issue_id: issueId,
          issue_identifier: entry?.identifier,
        });
        await this.terminateRunningIssue(issueId, false);
      }
    }
  }

  private async reconcileStalledRunningIssues(): Promise<OrchestratorState> {
    const timeoutMs = this.config.codex.stallTimeoutMs;
    if (timeoutMs <= 0) return this.state;
    if (this.state.running.size === 0) return this.state;

    const now = new Date();
    let state = this.state;

    for (const [issueId, entry] of state.running) {
      const elapsed = this.stallElapsedMs(entry, now);
      if (elapsed != null && elapsed > timeoutMs) {
        logger.warn('Issue stalled; terminating', {
          issue_id: issueId,
          issue_identifier: entry.identifier,
          session_id: entry.sessionId ?? 'n/a',
          elapsed_ms: elapsed,
        });

        entry.abortController.abort();
        const nextAttempt = entry.retryAttempt > 0 ? entry.retryAttempt + 1 : 1;
        state = await this.workspaceLifecycle.terminateAndClean(state, issueId, this.config, false);
        state = this.retryManager.schedule(state, issueId, nextAttempt, {
          identifier: entry.identifier,
          error: `stalled for ${elapsed}ms without codex activity`,
        }, this.config.agent.maxRetryBackoffMs);
      }
    }

    return state;
  }

  private reconcileBlockedIssues(): OrchestratorState {
    // Blocked issues (input-required) are not tracked separately in the base implementation
    // This is a simplified version — full blocking logic can be added as an extension
    return this.state;
  }

  private stallElapsedMs(entry: RunningEntry, now: Date): number | null {
    const lastActivity = entry.lastCodexTimestamp ?? entry.startedAt;
    if (!lastActivity) return null;
    return Math.max(0, now.getTime() - lastActivity.getTime());
  }

  private async terminateRunningIssue(issueId: string, cleanupWorkspace: boolean): Promise<OrchestratorState> {
    this.state = await this.workspaceLifecycle.terminateAndClean(this.state, issueId, this.config, cleanupWorkspace);
    return this.state;
  }

  // ── Retry ──

  private async handleRetry(issueId: string, retryToken: symbol): Promise<void> {
    const retry = this.retryManager.claimDueEntry(this.state, issueId, retryToken);
    if (!retry) return;

    const result = await fetchCandidateIssues(this.config);
    if (!result.ok) {
      logger.warn('Retry poll failed', {
        issue_id: issueId,
        issue_identifier: retry.identifier,
        error: result.error.message,
      });
      this.state = this.retryManager.schedule(this.state, issueId, retry.attempt + 1, {
        identifier: retry.identifier,
        error: `retry poll failed: ${result.error.message}`,
      }, this.config.agent.maxRetryBackoffMs);
      return;
    }

    const issue = result.value.find((i) => i.id === issueId);
    if (!issue) {
      logger.debug('Issue no longer visible; releasing claim', { issue_id: issueId });
      this.releaseIssueClaim(this.state, issueId);
      this.emit('update');
      return;
    }

    const terminalStates = this.terminalStateSet();
    if (terminalStates.has(this.normalizeIssueState(issue.state))) {
      logger.info('Issue terminal; cleaning workspace', {
        issue_id: issueId,
        issue_identifier: issue.identifier,
        state: issue.state,
      });
      try {
        await this.workspaceLifecycle.removeWorkspaceByIdentifier(issue.identifier, this.config);
      } catch {
        // best effort
      }
      this.releaseIssueClaim(this.state, issueId);
      this.emit('update');
      return;
    }

    if (this.dispatchScheduler.availableSlots(this.state) <= 0) {
      this.state = this.retryManager.schedule(this.state, issueId, retry.attempt + 1, {
        identifier: issue.identifier,
        error: 'no available orchestrator slots',
      }, this.config.agent.maxRetryBackoffMs);
      return;
    }

    this.dispatchIssue(issue, retry.attempt);
  }

  private releaseIssueClaim(state: OrchestratorState, issueId: string): OrchestratorState {
    state.claimed.delete(issueId);
    state.retryAttempts.delete(issueId);
    return state;
  }

  // ── Startup cleanup ──

  private runStartupTerminalCleanup(): void {
    fetchIssuesByStates(this.config.tracker.terminalStates, this.config)
      .then(async (result) => {
        if (!result.ok) {
          logger.warn('Skipping startup terminal workspace cleanup', { error: result.error.message });
          return;
        }
        for (const issue of result.value) {
          if (issue.identifier) {
            try {
              await this.workspaceLifecycle.removeWorkspaceByIdentifier(issue.identifier, this.config);
            } catch {
              // best effort
            }
          }
        }
      })
      .catch(() => {
        // best effort
      });
  }

  // ── Refresh ──

  requestRefresh(): { queued: boolean; coalesced: boolean; requested_at: string; operations: string[] } {
    const nowMs = Date.now();
    const alreadyDue = this.nextPollDueAtMs != null && this.nextPollDueAtMs <= nowMs;
    const coalesced = this.pollCheckInProgress || alreadyDue;

    if (!coalesced) {
      this.scheduleTick(0);
    }

    return {
      queued: true,
      coalesced,
      requested_at: new Date().toISOString(),
      operations: ['poll', 'reconcile'],
    };
  }

  // ── Snapshot ──

  snapshot(): RuntimeSnapshot {
    const now = new Date();

    const running: RunningSessionRow[] = [...this.state.running.entries()].map(([, entry]) => ({
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

    const retrying: RetryQueueRow[] = [...this.state.retryAttempts.entries()].map(([, retry]) => ({
      issue_id: retry.issueId,
      issue_identifier: retry.identifier,
      attempt: retry.attempt,
      due_at: new Date(retry.dueAtMs).toISOString(),
      error: retry.error,
    }));

    // Add active session runtimes to totals
    let activeSeconds = 0;
    for (const [, entry] of this.state.running) {
      activeSeconds += (now.getTime() - entry.startedAt.getTime()) / 1000;
    }

    return {
      generated_at: now.toISOString(),
      counts: {
        running: this.state.running.size,
        retrying: this.state.retryAttempts.size,
      },
      running,
      retrying,
      codex_totals: {
        ...this.state.codexTotals,
        seconds_running: this.state.codexTotals.secondsRunning + activeSeconds,
      },
      rate_limits: this.state.codexRateLimits,
    };
  }

  getState(): OrchestratorState {
    return this.state;
  }

  getConfig(): ServiceConfig {
    return this.config;
  }

  // ── Helpers ──

  private activeStateSet(): Set<string> {
    return new Set(this.config.tracker.activeStates.map((s) => this.normalizeIssueState(s)).filter((s) => s !== ''));
  }

  private terminalStateSet(): Set<string> {
    return new Set(this.config.tracker.terminalStates.map((s) => this.normalizeIssueState(s)).filter((s) => s !== ''));
  }

  private normalizeIssueState(stateName: string): string {
    return stateName.toLowerCase().trim();
  }
}
