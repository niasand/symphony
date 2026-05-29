import { describe, it, expect } from 'vitest';
import { DispatchScheduler } from '../src/orchestrator/dispatch-scheduler.js';
import { defaultConfig, sampleIssue } from './helpers.js';
import type { Issue, OrchestratorState, ServiceConfig, CodexTotals } from '../src/types.js';

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

describe('DispatchScheduler — sortCandidates', () => {
  const scheduler = new DispatchScheduler();

  it('sorts by priority ascending', () => {
    const issues = [
      sampleIssue({ id: '1', identifier: 'A', priority: 4, state: 'Todo' }),
      sampleIssue({ id: '2', identifier: 'B', priority: 1, state: 'Todo' }),
      sampleIssue({ id: '3', identifier: 'C', priority: 2, state: 'Todo' }),
    ];
    const sorted = scheduler.sortCandidates(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(['B', 'C', 'A']);
  });

  it('sorts null priority last', () => {
    const issues = [
      sampleIssue({ id: '1', identifier: 'A', priority: null, state: 'Todo' }),
      sampleIssue({ id: '2', identifier: 'B', priority: 2, state: 'Todo' }),
      sampleIssue({ id: '3', identifier: 'C', priority: null, state: 'Todo' }),
    ];
    const sorted = scheduler.sortCandidates(issues);
    expect(sorted[0].identifier).toBe('B');
  });

  it('returns new array without mutating input', () => {
    const issues = [
      sampleIssue({ id: '1', identifier: 'A', priority: 3, state: 'Todo' }),
      sampleIssue({ id: '2', identifier: 'B', priority: 1, state: 'Todo' }),
    ];
    const sorted = scheduler.sortCandidates(issues);
    expect(sorted).not.toBe(issues);
    expect(issues[0].identifier).toBe('A');
  });
});

describe('DispatchScheduler — shouldDispatch', () => {
  const scheduler = new DispatchScheduler();
  const config = defaultConfig();

  it('rejects missing id', () => {
    const issue = sampleIssue({ id: '', identifier: 'SYM-1', title: 'T', state: 'Todo' });
    expect(scheduler.shouldDispatch(issue, makeState(), config)).toBe(false);
  });

  it('rejects missing identifier', () => {
    const issue = sampleIssue({ id: 'id1', identifier: '', title: 'T', state: 'Todo' });
    expect(scheduler.shouldDispatch(issue, makeState(), config)).toBe(false);
  });

  it('rejects already claimed issue', () => {
    const issue = sampleIssue({ id: 'claimed-1', state: 'Todo' });
    const state = makeState({ claimed: new Set(['claimed-1']) });
    expect(scheduler.shouldDispatch(issue, state, config)).toBe(false);
  });

  it('rejects issue in terminal state', () => {
    const issue = sampleIssue({ state: 'Done' });
    expect(scheduler.shouldDispatch(issue, makeState(), config)).toBe(false);
  });

  it('accepts valid issue in active state', () => {
    const issue = sampleIssue({ state: 'Todo' });
    expect(scheduler.shouldDispatch(issue, makeState(), config)).toBe(true);
  });

  it('rejects when no slots available', () => {
    const zeroSlotConfig = defaultConfig({
      agent: {
        maxConcurrentAgents: 0,
        maxTurns: 20,
        maxRetryBackoffMs: 300000,
        maxConcurrentAgentsByState: {},
      },
    });
    const issue = sampleIssue({ state: 'Todo' });
    const state = makeState({ maxConcurrentAgents: 0 });
    expect(scheduler.shouldDispatch(issue, state, zeroSlotConfig)).toBe(false);
  });
});

describe('DispatchScheduler — availableSlots', () => {
  const scheduler = new DispatchScheduler();

  it('returns maxConcurrentAgents when nothing running', () => {
    expect(scheduler.availableSlots(makeState())).toBe(10);
  });

  it('returns 0 when running equals max', () => {
    const running = new Map();
    for (let i = 0; i < 10; i++) {
      running.set(`id-${i}`, {} as any);
    }
    expect(scheduler.availableSlots(makeState({ running }))).toBe(0);
  });
});
