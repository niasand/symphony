// DispatchScheduler — extracted from Orchestrator
// Manages issue sorting, dispatch eligibility, and slot management.

import type { Issue, OrchestratorState, ServiceConfig } from '../types.js';

export class DispatchScheduler {
  // ── Public API ──

  /** Sort issues for dispatch: priority ascending, then created_at ascending, then identifier. */
  sortCandidates(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const pa = a.priority != null && a.priority >= 1 && a.priority <= 4 ? a.priority : 5;
      const pb = b.priority != null && b.priority >= 1 && b.priority <= 4 ? b.priority : 5;
      if (pa !== pb) return pa - pb;
      const ta = a.created_at ? a.created_at.getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.created_at ? b.created_at.getTime() : Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return (a.identifier || a.id || '').localeCompare(b.identifier || b.id || '');
    });
  }

  /**
   * Determine whether an issue should be dispatched.
   * Pure function — no side effects.
   */
  shouldDispatch(
    issue: Issue,
    state: OrchestratorState,
    config: ServiceConfig,
  ): boolean {
    const activeStates = this.activeStateSet(config);
    const terminalStates = this.terminalStateSet(config);

    return (
      this.candidateIssue(issue, activeStates, terminalStates) &&
      !this.todoIssueBlockedByNonTerminal(issue, terminalStates) &&
      !state.claimed.has(issue.id) &&
      !state.running.has(issue.id) &&
      this.availableSlots(state) > 0 &&
      this.stateSlotsAvailable(issue, state, config)
    );
  }

  /** Calculate available dispatch slots. */
  availableSlots(state: OrchestratorState): number {
    return Math.max(state.maxConcurrentAgents - state.running.size, 0);
  }

  // ── Internal helpers ──

  private candidateIssue(issue: Issue, activeStates: Set<string>, terminalStates: Set<string>): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    const normalizedState = this.normalizeIssueState(issue.state);
    return activeStates.has(normalizedState) && !terminalStates.has(normalizedState);
  }

  private todoIssueBlockedByNonTerminal(issue: Issue, terminalStates: Set<string>): boolean {
    if (this.normalizeIssueState(issue.state) !== 'todo') return false;
    if (!issue.blocked_by || issue.blocked_by.length === 0) return false;
    return issue.blocked_by.some((blocker) => {
      if (!blocker.state) return true;
      return !terminalStates.has(this.normalizeIssueState(blocker.state));
    });
  }

  private stateSlotsAvailable(issue: Issue, state: OrchestratorState, config: ServiceConfig): boolean {
    const normalizedState = this.normalizeIssueState(issue.state);
    const limit = config.agent.maxConcurrentAgentsByState[normalizedState];
    if (limit == null) return true;
    let used = 0;
    for (const [, entry] of state.running) {
      if (this.normalizeIssueState(entry.issue.state) === normalizedState) used++;
    }
    return limit > used;
  }

  private activeStateSet(config: ServiceConfig): Set<string> {
    return new Set(config.tracker.activeStates.map((s) => this.normalizeIssueState(s)).filter((s) => s !== ''));
  }

  private terminalStateSet(config: ServiceConfig): Set<string> {
    return new Set(config.tracker.terminalStates.map((s) => this.normalizeIssueState(s)).filter((s) => s !== ''));
  }

  private normalizeIssueState(stateName: string): string {
    return stateName.toLowerCase().trim();
  }
}
