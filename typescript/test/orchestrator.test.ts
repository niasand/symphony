import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../src/orchestrator/index.js';
import { defaultConfig, sampleIssue } from './helpers.js';
import type { Issue, ServiceConfig, Result } from '../src/types.js';
import type { CodexUpdateEvent } from '../src/types.js';

function noopWorkerRun(): (
  issue: Issue,
  attempt: number | null,
  config: ServiceConfig,
  onMessage: (event: CodexUpdateEvent) => void,
  signal: AbortSignal,
) => Promise<Result<void>> {
  return async () => ({ ok: true, value: undefined });
}

function makeOrchestrator(config?: ServiceConfig): Orchestrator {
  return new Orchestrator(
    '/tmp/WORKFLOW.md',
    config ?? defaultConfig(),
    noopWorkerRun(),
  );
}

describe('Orchestrator — sortIssuesForDispatch', () => {
  it('sorts by priority ascending (1 before 4)', () => {
    const orch = makeOrchestrator();
    const issues = [
      sampleIssue({ id: '1', identifier: 'A', priority: 4, state: 'Todo' }),
      sampleIssue({ id: '2', identifier: 'B', priority: 1, state: 'Todo' }),
      sampleIssue({ id: '3', identifier: 'C', priority: 2, state: 'Todo' }),
    ];

    const sorted = orch.sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(['B', 'C', 'A']);
  });

  it('sorts null priority last', () => {
    const orch = makeOrchestrator();
    const issues = [
      sampleIssue({ id: '1', identifier: 'A', priority: null, state: 'Todo' }),
      sampleIssue({ id: '2', identifier: 'B', priority: 2, state: 'Todo' }),
      sampleIssue({ id: '3', identifier: 'C', priority: null, state: 'Todo' }),
    ];

    const sorted = orch.sortIssuesForDispatch(issues);
    expect(sorted[0].identifier).toBe('B');
    // Null priorities (mapped to 5) come after 2
    expect(sorted[1].identifier).toBeDefined();
    expect(sorted[2].identifier).toBeDefined();
  });

  it('sorts by created_at ascending (oldest first)', () => {
    const orch = makeOrchestrator();
    const issues = [
      sampleIssue({
        id: '1', identifier: 'A', priority: 1, state: 'Todo',
        created_at: new Date('2025-06-01T00:00:00Z'),
      }),
      sampleIssue({
        id: '2', identifier: 'B', priority: 1, state: 'Todo',
        created_at: new Date('2025-01-01T00:00:00Z'),
      }),
      sampleIssue({
        id: '3', identifier: 'C', priority: 1, state: 'Todo',
        created_at: new Date('2025-03-01T00:00:00Z'),
      }),
    ];

    const sorted = orch.sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(['B', 'C', 'A']);
  });

  it('sorts by identifier as tiebreaker', () => {
    const orch = makeOrchestrator();
    const issues = [
      sampleIssue({
        id: '1', identifier: 'SYM-10', priority: 1, state: 'Todo',
        created_at: new Date('2025-01-01T00:00:00Z'),
      }),
      sampleIssue({
        id: '2', identifier: 'SYM-2', priority: 1, state: 'Todo',
        created_at: new Date('2025-01-01T00:00:00Z'),
      }),
      sampleIssue({
        id: '3', identifier: 'SYM-1', priority: 1, state: 'Todo',
        created_at: new Date('2025-01-01T00:00:00Z'),
      }),
    ];

    const sorted = orch.sortIssuesForDispatch(issues);
    expect(sorted.map((i) => i.identifier)).toEqual(['SYM-1', 'SYM-10', 'SYM-2']);
  });

  it('returns new array without mutating input', () => {
    const orch = makeOrchestrator();
    const issues = [
      sampleIssue({ id: '1', identifier: 'A', priority: 3, state: 'Todo' }),
      sampleIssue({ id: '2', identifier: 'B', priority: 1, state: 'Todo' }),
    ];

    const sorted = orch.sortIssuesForDispatch(issues);
    expect(sorted).not.toBe(issues);
    expect(issues[0].identifier).toBe('A'); // Input not mutated
  });
});

describe('Orchestrator — shouldDispatchIssue', () => {
  it('rejects missing id', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ id: '', identifier: 'SYM-1', title: 'T', state: 'Todo' });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects missing identifier', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ id: 'id1', identifier: '', title: 'T', state: 'Todo' });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects missing title', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ id: 'id1', identifier: 'SYM-1', title: '', state: 'Todo' });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects missing state', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ id: 'id1', identifier: 'SYM-1', title: 'T', state: '' });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects already claimed issue', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ id: 'claimed-1', state: 'Todo' });
    orch.getState().claimed.add('claimed-1');
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects already running issue', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ id: 'running-1', state: 'Todo' });
    // Manually add to running map
    orch.getState().running.set('running-1', {
      issueId: 'running-1',
      identifier: 'SYM-1',
      issue,
      retryAttempt: 0,
      startedAt: new Date(),
      workerHost: null,
      workspacePath: null,
      abortController: new AbortController(),
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
    } as any);
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects Todo with non-terminal blockers', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({
      id: 'blocked-1',
      state: 'Todo',
      blocked_by: [
        { id: 'b1', identifier: 'SYM-99', state: 'In Progress' },
      ],
    });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('accepts Todo with terminal blockers', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({
      id: 'unblocked-1',
      state: 'Todo',
      blocked_by: [
        { id: 'b1', identifier: 'SYM-99', state: 'Done' },
      ],
    });
    expect(orch.shouldDispatchIssue(issue)).toBe(true);
  });

  it('accepts Todo with blockers that have null state (treated as non-terminal)', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({
      id: 'null-blocked',
      state: 'Todo',
      blocked_by: [
        { id: 'b1', identifier: 'SYM-99', state: null },
      ],
    });
    // null state on blocker means "we don't know" — treated as non-terminal
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects when no slots available', () => {
    const config = defaultConfig({
      agent: {
        maxConcurrentAgents: 0,
        maxTurns: 20,
        maxRetryBackoffMs: 300000,
        maxConcurrentAgentsByState: {},
      },
    });
    const orch = makeOrchestrator(config);
    const issue = sampleIssue({ state: 'Todo' });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects issue in terminal state', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ state: 'Done' });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('rejects issue in non-active, non-terminal state', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ state: 'Backlog' });
    expect(orch.shouldDispatchIssue(issue)).toBe(false);
  });

  it('accepts valid issue in active state', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ state: 'Todo' });
    expect(orch.shouldDispatchIssue(issue)).toBe(true);
  });

  it('accepts In Progress state', () => {
    const orch = makeOrchestrator();
    const issue = sampleIssue({ state: 'In Progress' });
    expect(orch.shouldDispatchIssue(issue)).toBe(true);
  });

  it('respects state-level slot limits', () => {
    const config = defaultConfig({
      agent: {
        maxConcurrentAgents: 10,
        maxTurns: 20,
        maxRetryBackoffMs: 300000,
        maxConcurrentAgentsByState: { 'todo': 1 },
      },
    });
    const orch = makeOrchestrator(config);

    // Fill the state slot
    const runningIssue = sampleIssue({ id: 'running-1', state: 'Todo' });
    orch.getState().running.set('running-1', {
      issueId: 'running-1',
      identifier: 'SYM-R1',
      issue: runningIssue,
      retryAttempt: 0,
      startedAt: new Date(),
      workerHost: null,
      workspacePath: null,
      abortController: new AbortController(),
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
    } as any);

    const newIssue = sampleIssue({ id: 'new-1', state: 'Todo' });
    expect(orch.shouldDispatchIssue(newIssue)).toBe(false);
  });
});
