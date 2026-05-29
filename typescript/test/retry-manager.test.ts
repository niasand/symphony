import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryManager } from '../src/orchestrator/retry-manager.js';
import type { OrchestratorState, CodexTotals } from '../src/types.js';

function makeState(overrides?: Partial<OrchestratorState>): OrchestratorState {
  return {
    pollIntervalMs: 30000,
    maxConcurrentAgents: 10,
    running: new Map(),
    claimed: new Set(),
    retryAttempts: new Map(),
    completed: new Set(),
    codexTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, secondsRunning: 0 },
    codexRateLimits: null,
    ...overrides,
  };
}

describe('RetryManager', () => {
  let callback: ReturnType<typeof vi.fn>;
  let manager: RetryManager;

  beforeEach(() => {
    callback = vi.fn();
    manager = new RetryManager(callback);
  });

  it('schedule creates a retry entry and sets a timer', () => {
    vi.useFakeTimers();
    const state = makeState();
    const updated = manager.schedule(state, 'issue-1', 1, { identifier: 'SYM-1' }, 300000);

    expect(updated.retryAttempts.has('issue-1')).toBe(true);
    const entry = updated.retryAttempts.get('issue-1')!;
    expect(entry.issueId).toBe('issue-1');
    expect(entry.attempt).toBe(1);
    expect(entry.identifier).toBe('SYM-1');

    vi.useRealTimers();
  });

  it('claimDueEntry returns entry and deletes from state when token matches', () => {
    vi.useFakeTimers();
    const state = makeState();
    const updated = manager.schedule(state, 'issue-1', 2, { identifier: 'SYM-2' }, 300000);
    const entry = updated.retryAttempts.get('issue-1')!;
    const token = entry.retryToken;

    const claimed = manager.claimDueEntry(updated, 'issue-1', token);
    expect(claimed).not.toBeNull();
    expect(claimed!.attempt).toBe(2);
    expect(updated.retryAttempts.has('issue-1')).toBe(false);

    vi.useRealTimers();
  });

  it('claimDueEntry returns null when token does not match', () => {
    vi.useFakeTimers();
    const state = makeState();
    const updated = manager.schedule(state, 'issue-1', 1, { identifier: 'SYM-1' }, 300000);

    const claimed = manager.claimDueEntry(updated, 'issue-1', Symbol('wrong'));
    expect(claimed).toBeNull();
    expect(updated.retryAttempts.has('issue-1')).toBe(true);

    vi.useRealTimers();
  });

  it('cancel removes a specific retry entry', () => {
    vi.useFakeTimers();
    const state = makeState();
    const updated = manager.schedule(state, 'issue-1', 1, { identifier: 'SYM-1' }, 300000);

    manager.cancel(updated, 'issue-1');
    expect(updated.retryAttempts.has('issue-1')).toBe(false);

    vi.useRealTimers();
  });

  it('cancelAll clears all entries', () => {
    vi.useFakeTimers();
    const state = makeState();
    let updated = manager.schedule(state, 'issue-1', 1, { identifier: 'SYM-1' }, 300000);
    updated = manager.schedule(updated, 'issue-2', 1, { identifier: 'SYM-2' }, 300000);

    manager.cancelAll(updated);
    expect(updated.retryAttempts.size).toBe(0);

    vi.useRealTimers();
  });

  it('has returns correct boolean', () => {
    vi.useFakeTimers();
    const state = makeState();
    expect(manager.has(state, 'issue-1')).toBe(false);

    const updated = manager.schedule(state, 'issue-1', 1, { identifier: 'SYM-1' }, 300000);
    expect(manager.has(updated, 'issue-1')).toBe(true);

    vi.useRealTimers();
  });

  it('continuation delay type with attempt 1 uses short delay', () => {
    vi.useFakeTimers();
    const state = makeState();
    const updated = manager.schedule(state, 'issue-1', 1, { delayType: 'continuation' }, 300000);
    const entry = updated.retryAttempts.get('issue-1')!;

    // dueAtMs should be Date.now() + 1000 (CONTINUATION_RETRY_DELAY_MS)
    expect(entry.dueAtMs - Date.now()).toBeLessThanOrEqual(1000);

    vi.useRealTimers();
  });

  it('fires callback when timer expires', () => {
    vi.useFakeTimers();
    const state = makeState();
    manager.schedule(state, 'issue-1', 1, { identifier: 'SYM-1' }, 300000);

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60000); // enough for any delay
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('issue-1', expect.any(Symbol));

    vi.useRealTimers();
  });
});
