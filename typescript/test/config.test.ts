import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseConfig, validateDispatchConfig } from '../src/config/index.js';
import { defaultConfig } from './helpers.js';

describe('config/parseConfig', () => {
  let tmpHome: string | undefined;

  beforeEach(() => {
    tmpHome = process.env.HOME;
  });

  afterEach(() => {
    if (tmpHome !== undefined) {
      vi.stubEnv('HOME', tmpHome);
    }
    vi.unstubAllEnvs();
  });

  it('applies all defaults when optional values missing', () => {
    const result = parseConfig({}, '/tmp/workflow');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const config = result.value;
    expect(config.tracker.kind).toBe('linear');
    expect(config.tracker.endpoint).toBe('https://api.linear.app/graphql');
    expect(config.tracker.apiKey).toBeNull();
    expect(config.tracker.projectSlug).toBeNull();
    expect(config.tracker.activeStates).toEqual(['Todo', 'In Progress']);
    expect(config.tracker.terminalStates).toEqual(['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done']);
    expect(config.polling.intervalMs).toBe(30000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.agent.maxRetryBackoffMs).toBe(300000);
    expect(config.hooks.timeoutMs).toBe(60000);
    expect(config.codex.command).toBe('codex app-server');
    expect(config.codex.turnTimeoutMs).toBe(3600000);
    expect(config.codex.readTimeoutMs).toBe(5000);
    expect(config.codex.stallTimeoutMs).toBe(300000);
    expect(config.worker.sshHosts).toEqual([]);
    expect(config.server.port).toBeNull();
  });

  it('resolves $VAR references using process.env', () => {
    vi.stubEnv('MY_API_KEY', 'resolved-key-123');

    const result = parseConfig(
      { tracker: { kind: 'linear', apiKey: '$MY_API_KEY', projectSlug: 'SYM' } },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.apiKey).toBe('resolved-key-123');
  });

  it('returns null for unresolved $VAR (empty env var)', () => {
    vi.stubEnv('EMPTY_VAR', '');

    const result = parseConfig(
      { tracker: { kind: 'linear', apiKey: '$EMPTY_VAR', projectSlug: 'SYM' } },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.apiKey).toBeNull();
  });

  it('expands ~ in workspace.root', () => {
    const home = '/home/testuser';
    vi.stubEnv('HOME', home);

    const result = parseConfig(
      { workspace: { root: '~/my-workspaces' } },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.root).toBe(`${home}/my-workspaces`);
  });

  it('resolves relative workspace.root against workflowDir', () => {
    const result = parseConfig(
      { workspace: { root: 'relative-path' } },
      '/project/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should be resolved to absolute path
    expect(result.value.workspace.root).toContain('relative-path');
    expect(result.value.workspace.root).toMatch(/^\//);
  });

  it('normalizes to absolute path', () => {
    const result = parseConfig({}, '/tmp/workflow');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.workspace.root).toMatch(/^\//);
  });

  it('validates numeric constraints: intervalMs > 0', () => {
    const result = parseConfig({ polling: { intervalMs: 0 } }, '/tmp/workflow');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('intervalMs');
  });

  it('validates numeric constraints: negative intervalMs', () => {
    const result = parseConfig({ polling: { intervalMs: -100 } }, '/tmp/workflow');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
  });

  it('validates numeric constraints: maxTurns > 0', () => {
    const result = parseConfig({ agent: { maxTurns: 0 } }, '/tmp/workflow');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('maxTurns');
  });

  it('validates numeric constraints: maxConcurrentAgents > 0', () => {
    const result = parseConfig({ agent: { maxConcurrentAgents: -1 } }, '/tmp/workflow');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
  });

  it('validates stallTimeoutMs >= 0 (zero is allowed)', () => {
    const result = parseConfig({ codex: { stallTimeoutMs: 0 } }, '/tmp/workflow');

    expect(result.ok).toBe(true);
  });

  it('validates stallTimeoutMs >= 0 (negative is rejected)', () => {
    const result = parseConfig({ codex: { stallTimeoutMs: -1 } }, '/tmp/workflow');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('stallTimeoutMs');
  });

  it('returns invalid_workflow_config for constraint violations', () => {
    const result = parseConfig(
      { polling: { intervalMs: -1 }, agent: { maxTurns: -1 } },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('intervalMs');
    expect(result.error.message).toContain('maxTurns');
  });

  it('supports snake_case YAML keys (api_key -> apiKey)', () => {
    const result = parseConfig(
      {
        tracker: { api_key: 'my-key', project_slug: 'PROJ' },
      },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.apiKey).toBe('my-key');
    expect(result.value.tracker.projectSlug).toBe('PROJ');
  });

  it('supports snake_case YAML keys (project_slug -> projectSlug)', () => {
    const result = parseConfig(
      { tracker: { project_slug: 'MY-PROJ' } },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.projectSlug).toBe('MY-PROJ');
  });

  it('supports camelCase keys directly', () => {
    const result = parseConfig(
      { tracker: { apiKey: 'direct-key', projectSlug: 'PROJ' } },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tracker.apiKey).toBe('direct-key');
  });

  it('parses maxConcurrentAgentsByState from raw config', () => {
    const result = parseConfig(
      { agent: { maxConcurrentAgentsByState: { 'In Progress': 3, 'todo': 5 } } },
      '/tmp/workflow',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Keys are lowercased by normalizeStateLimits
    expect(result.value.agent.maxConcurrentAgentsByState['in progress']).toBe(3);
    expect(result.value.agent.maxConcurrentAgentsByState['todo']).toBe(5);
  });
});

describe('config/validateDispatchConfig', () => {
  it('accepts valid config', () => {
    const config = defaultConfig();
    const result = validateDispatchConfig(config);
    expect(result.ok).toBe(true);
  });

  it('rejects missing tracker.kind', () => {
    const config = defaultConfig({
      tracker: {
        kind: '',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: 'key',
        projectSlug: 'SYM',
        activeStates: ['Todo'],
        terminalStates: ['Done'],
      },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('tracker.kind');
  });

  it('rejects unsupported tracker.kind', () => {
    const config = defaultConfig({
      tracker: {
        kind: 'jira',
        endpoint: 'https://jira.example.com',
        apiKey: 'key',
        projectSlug: 'SYM',
        activeStates: ['Todo'],
        terminalStates: ['Done'],
      },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('Unsupported tracker kind');
  });

  it('rejects missing api_key', () => {
    const config = defaultConfig({
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: null,
        projectSlug: 'SYM',
        activeStates: ['Todo'],
        terminalStates: ['Done'],
      },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('apiKey');
  });

  it('rejects missing project_slug for linear', () => {
    const config = defaultConfig({
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: 'key',
        projectSlug: null,
        activeStates: ['Todo'],
        terminalStates: ['Done'],
      },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('projectSlug');
  });

  it('rejects empty codex.command', () => {
    const config = defaultConfig({
      codex: {
        command: '   ',
        approvalPolicy: null,
        threadSandbox: null,
        turnSandboxPolicy: null,
        turnTimeoutMs: 3600000,
        readTimeoutMs: 5000,
        stallTimeoutMs: 300000,
      },
    });
    const result = validateDispatchConfig(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_workflow_config');
    expect(result.error.message).toContain('codex.command');
  });
});
