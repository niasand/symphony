import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Issue, ServiceConfig } from '../src/types.js';

export function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'symphony-test-'));
}

export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeWorkflowFile(dir: string, content: string): string {
  const path = join(dir, 'WORKFLOW.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}

export function defaultConfig(overrides?: Partial<ServiceConfig>): ServiceConfig {
  const base: ServiceConfig = {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      apiKey: 'lin_api_testkey123',
      projectSlug: 'SYM',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
    },
    polling: { intervalMs: 30000 },
    workspace: { root: '/tmp/symphony_test_workspaces' },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60000,
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: 'codex app-server',
      approvalPolicy: null,
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3600000,
      readTimeoutMs: 5000,
      stallTimeoutMs: 300000,
    },
    worker: {
      sshHosts: [],
      maxConcurrentAgentsPerHost: null,
    },
    server: {
      port: null,
    },
  };

  if (!overrides) return base;

  return {
    ...base,
    ...overrides,
    tracker: { ...base.tracker, ...overrides.tracker },
    polling: { ...base.polling, ...overrides.polling },
    workspace: { ...base.workspace, ...overrides.workspace },
    hooks: { ...base.hooks, ...overrides.hooks },
    agent: { ...base.agent, ...overrides.agent },
    codex: { ...base.codex, ...overrides.codex },
    worker: { ...base.worker, ...overrides.worker },
    server: { ...base.server, ...overrides.server },
  };
}

export function sampleIssue(overrides?: Partial<Issue>): Issue {
  const base: Issue = {
    id: 'issue-001',
    identifier: 'SYM-42',
    title: 'Fix login bug',
    description: 'Users cannot log in',
    priority: 2,
    state: 'Todo',
    branch_name: null,
    url: 'https://linear.app/issue/SYM-42',
    labels: ['bug', 'auth'],
    blocked_by: [],
    created_at: new Date('2025-01-15T10:00:00.000Z'),
    updated_at: new Date('2025-01-15T12:00:00.000Z'),
    assignee_id: 'user-001',
  };

  if (!overrides) return base;
  return { ...base, ...overrides };
}
