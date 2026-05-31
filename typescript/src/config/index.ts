// Config parsing — Spec Section 5

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Result, ServiceConfig, AgentConfig } from '../types.js';
import { TypedError } from '../types.js';
import { resolveEnvRef } from '../workspace/safety.js';

type RawConfig = Record<string, unknown>;

function obj(raw: RawConfig | undefined, key: string): Record<string, unknown> {
  const val = raw?.[key];
  if (val && typeof val === 'object' && !Array.isArray(val)) return val as Record<string, unknown>;
  return {};
}

// YAML front matter uses snake_case (spec 5.3), support both forms
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function lookup(raw: Record<string, unknown>, key: string): unknown {
  if (key in raw) return raw[key];
  const camelKey = snakeToCamel(key);
  if (camelKey in raw) return raw[camelKey];
  const snakeKey = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  if (snakeKey in raw) return raw[snakeKey];
  return undefined;
}

function str(raw: Record<string, unknown>, key: string, fallback: string): string {
  const val = lookup(raw, key);
  if (typeof val !== 'string') return fallback;
  const envResolved = resolveEnvRef(val);
  if (envResolved === null) return fallback;
  if (envResolved === undefined) return val;
  return envResolved;
}

function nullableStr(raw: Record<string, unknown>, key: string): string | null {
  const val = lookup(raw, key);
  if (typeof val !== 'string') return null;
  const envResolved = resolveEnvRef(val);
  if (envResolved === null) return null;
  if (envResolved === undefined) return val;
  return envResolved;
}

function num(raw: Record<string, unknown>, key: string, fallback: number): number {
  const val = lookup(raw, key);
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const parsed = Number(val);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function nullableNum(raw: Record<string, unknown>, key: string): number | null {
  const val = lookup(raw, key);
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const parsed = Number(val);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function strArr(raw: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const val = lookup(raw, key);
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string');
  return fallback;
}

function bool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const val = lookup(raw, key);
  if (typeof val === 'boolean') return val;
  return fallback;
}

function normalizePath(p: string): string {
  if (p.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || tmpdir();
    p = home + p.slice(1);
  }
  return p;
}

export function parseConfig(raw: RawConfig, workflowDir: string): Result<ServiceConfig> {
  const tracker = obj(raw, 'tracker');
  const polling = obj(raw, 'polling');
  const workspace = obj(raw, 'workspace');
  const hooks = obj(raw, 'hooks');
  const agent = obj(raw, 'agent');
  const codex = obj(raw, 'codex');
  const worker = obj(raw, 'worker');
  const server = obj(raw, 'server');

  const defaultRoot = resolve(tmpdir(), 'symphony_workspaces');

  let workspaceRoot = str(workspace, 'root', defaultRoot);
  workspaceRoot = normalizePath(workspaceRoot);
  if (!resolve(workspaceRoot).startsWith('/')) {
    workspaceRoot = resolve(workflowDir, workspaceRoot);
  }
  workspaceRoot = resolve(workspaceRoot);

  const rawStateLimits = (agent as Record<string, unknown>)?.maxConcurrentAgentsByState;
  const maxConcurrentAgentsByState = normalizeStateLimits(rawStateLimits);

  const intervalMs = num(polling, 'intervalMs', 30000);
  const agentKind = parseAgentKind(str(agent, 'kind', 'codex'));
  const maxConcurrentAgents = num(agent, 'maxConcurrentAgents', 10);
  const maxTurns = num(agent, 'maxTurns', 20);
  const maxRetryBackoffMs = num(agent, 'maxRetryBackoffMs', 300000);
  const hookTimeoutMs = num(hooks, 'timeoutMs', 60000);
  const turnTimeoutMs = num(codex, 'turnTimeoutMs', 3600000);
  const readTimeoutMs = num(codex, 'readTimeoutMs', 5000);
  const stallTimeoutMs = num(codex, 'stallTimeoutMs', 300000);

  const errors: string[] = [];

  if (agentKind === undefined) errors.push('agent.kind must be "codex"');
  if (intervalMs <= 0) errors.push('polling.intervalMs must be > 0');
  if (maxConcurrentAgents <= 0) errors.push('agent.maxConcurrentAgents must be > 0');
  if (maxTurns <= 0) errors.push('agent.maxTurns must be > 0');
  if (maxRetryBackoffMs <= 0) errors.push('agent.maxRetryBackoffMs must be > 0');
  if (hookTimeoutMs <= 0) errors.push('hooks.timeoutMs must be > 0');
  if (turnTimeoutMs <= 0) errors.push('codex.turnTimeoutMs must be > 0');
  if (readTimeoutMs <= 0) errors.push('codex.readTimeoutMs must be > 0');
  if (stallTimeoutMs < 0) errors.push('codex.stallTimeoutMs must be >= 0');

  if (errors.length > 0) {
    return {
      ok: false,
      error: new TypedError('invalid_workflow_config', `Config validation failed: ${errors.join('; ')}`),
    };
  }

  const config: ServiceConfig = {
    tracker: {
      kind: str(tracker, 'kind', 'linear'),
      endpoint: str(tracker, 'endpoint', 'https://api.linear.app/graphql'),
      apiKey: nullableStr(tracker, 'apiKey'),
      projectSlug: nullableStr(tracker, 'projectSlug'),
      activeStates: strArr(tracker, 'activeStates', ['Todo', 'In Progress']),
      terminalStates: strArr(tracker, 'terminalStates', ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']),
    },
    polling: { intervalMs },
    workspace: { root: workspaceRoot },
    hooks: {
      afterCreate: nullableStr(hooks, 'afterCreate'),
      beforeRun: nullableStr(hooks, 'beforeRun'),
      afterRun: nullableStr(hooks, 'afterRun'),
      beforeRemove: nullableStr(hooks, 'beforeRemove'),
      timeoutMs: hookTimeoutMs,
    },
    agent: {
      kind: agentKind ?? 'codex',
      maxConcurrentAgents,
      maxTurns,
      maxRetryBackoffMs,
      maxConcurrentAgentsByState,
    },
    codex: {
      command: str(codex, 'command', 'codex app-server'),
      approvalPolicy: nullableStr(codex, 'approvalPolicy'),
      threadSandbox: nullableStr(codex, 'threadSandbox'),
      turnSandboxPolicy: nullableStr(codex, 'turnSandboxPolicy'),
      turnTimeoutMs,
      readTimeoutMs,
      stallTimeoutMs,
    },
    worker: {
      sshHosts: strArr(worker, 'sshHosts', []),
      maxConcurrentAgentsPerHost: nullableNum(worker, 'maxConcurrentAgentsPerHost'),
    },
    server: {
      port: nullableNum(server, 'port'),
    },
  };

  return { ok: true, value: config };
}

function normalizeStateLimits(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'number' && val > 0) {
      result[key.toLowerCase()] = val;
    }
  }
  return result;
}

function parseAgentKind(raw: string): AgentConfig['kind'] | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  return undefined;
}

export function validateDispatchConfig(config: ServiceConfig): Result<void> {
  const errors: string[] = [];

  if (!config.tracker.kind) {
    errors.push('tracker.kind is required');
  } else if (config.tracker.kind !== 'linear') {
    errors.push(`Unsupported tracker kind: ${config.tracker.kind}`);
  }

  if (!config.tracker.apiKey) {
    errors.push('tracker.apiKey is required');
  }

  if (!config.tracker.projectSlug) {
    errors.push('tracker.projectSlug is required for linear tracker');
  }

  // Validate agent-specific command config
  if (!config.codex.command || config.codex.command.trim() === '') {
    errors.push('codex.command must be non-empty');
  }

  if (errors.length > 0) {
    return {
      ok: false,
      error: new TypedError('invalid_workflow_config', `Dispatch config validation failed: ${errors.join('; ')}`),
    };
  }

  return { ok: true, value: undefined };
}
