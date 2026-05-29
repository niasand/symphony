import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeLinearGraphql, LINEAR_GRAPHQL_TOOL_SPEC } from '../src/agent/tools/linear-graphql.js';
import type { ServiceConfig } from '../src/types.js';

// ── Helpers ──

function makeConfig(overrides?: Partial<ServiceConfig['tracker']>): ServiceConfig {
  return {
    tracker: {
      kind: 'linear',
      endpoint: 'https://api.linear.app/graphql',
      apiKey: 'lin_api_testkey123',
      projectSlug: 'test-project',
      activeStates: ['In Progress'],
      terminalStates: ['Done'],
      ...overrides,
    },
    polling: { intervalMs: 5000 },
    workspace: { root: '/tmp/ws' },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 5000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 3, maxRetryBackoffMs: 1000, maxConcurrentAgentsByState: {} },
    codex: { command: 'echo', approvalPolicy: null, threadSandbox: null, turnSandboxPolicy: null, turnTimeoutMs: 60000, readTimeoutMs: 5000, stallTimeoutMs: 10000 },
    worker: { sshHosts: [], maxConcurrentAgentsPerHost: null },
    server: { port: null },
  };
}

// ── Tests ──

describe('LINEAR_GRAPHQL_TOOL_SPEC', () => {
  it('has correct name and required fields', () => {
    expect(LINEAR_GRAPHQL_TOOL_SPEC.name).toBe('linear_graphql');
    expect(LINEAR_GRAPHQL_TOOL_SPEC.inputSchema.required).toContain('query');
  });
});

describe('executeLinearGraphql', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  it('valid query + variables -> success', async () => {
    const mockData = { viewer: { id: 'u1', name: 'Test' } };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: mockData }),
    } as Response);

    const result = await executeLinearGraphql(
      { query: 'query { viewer { id name } }', variables: { first: 10 } },
      makeConfig(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockData);

    const call = fetchSpy.mock.calls[0]!;
    expect(call[1]!.headers).toHaveProperty('Authorization', 'lin_api_testkey123');
    const body = JSON.parse(call[1]!.body as string);
    expect(body.query).toBe('query { viewer { id name } }');
    expect(body.variables).toEqual({ first: 10 });
  });

  it('raw string input -> success (shorthand)', async () => {
    const mockData = { issues: { nodes: [] } };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: mockData }),
    } as Response);

    const result = await executeLinearGraphql(
      '{ issues { nodes { id } } }',
      makeConfig(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toEqual(mockData);
  });

  it('empty query -> failure', async () => {
    const result = await executeLinearGraphql(
      { query: '' },
      makeConfig(),
    );

    expect(result.success).toBe(false);
    expect((result.output as { error: string }).error).toContain('non-empty');
  });

  it('missing auth -> failure', async () => {
    const result = await executeLinearGraphql(
      { query: 'query { viewer { id } }' },
      makeConfig({ apiKey: null }),
    );

    expect(result.success).toBe(false);
    expect((result.output as { error: string }).error).toBe('missing Linear auth');
    // Should not have called fetch
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GraphQL errors in response -> success=false with preserved body', async () => {
    const errors = [{ message: 'Something went wrong' }];
    const partialData = { issues: null };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ errors, data: partialData }),
    } as Response);

    const result = await executeLinearGraphql(
      { query: 'query { bad }' },
      makeConfig(),
    );

    expect(result.success).toBe(false);
    const output = result.output as { errors: unknown[]; data: unknown };
    expect(output.errors).toEqual(errors);
    expect(output.data).toEqual(partialData);
  });

  it('multiple operations -> rejection', async () => {
    const multiOp = `
      query A { viewer { id } }
      query B { issues { nodes { id } } }
    `;
    const result = await executeLinearGraphql(
      { query: multiOp },
      makeConfig(),
    );

    expect(result.success).toBe(false);
    expect((result.output as { error: string }).error).toContain('exactly one');
  });

  it('non-object variables -> failure', async () => {
    const result = await executeLinearGraphql(
      { query: 'query { viewer { id } }', variables: 'not-an-object' },
      makeConfig(),
    );

    expect(result.success).toBe(false);
    expect((result.output as { error: string }).error).toContain('plain object');
  });

  it('transport failure -> failure with transport error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network down'));

    const result = await executeLinearGraphql(
      { query: 'query { viewer { id } }' },
      makeConfig(),
    );

    expect(result.success).toBe(false);
    expect((result.output as { error: string }).error).toContain('transport error');
    expect((result.output as { error: string }).error).toContain('Network down');
  });

  it('non-200 HTTP status -> failure', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response);

    const result = await executeLinearGraphql(
      { query: 'query { viewer { id } }' },
      makeConfig(),
    );

    expect(result.success).toBe(false);
    expect((result.output as { error: string }).error).toContain('status 500');
  });

  it('variables omitted -> query sent without variables field', async () => {
    const mockData = { viewer: { id: 'u1' } };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: mockData }),
    } as Response);

    const result = await executeLinearGraphql(
      { query: 'query { viewer { id } }' },
      makeConfig(),
    );

    expect(result.success).toBe(true);
    const call = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(call[1]!.body as string);
    expect(body).not.toHaveProperty('variables');
    expect(body.query).toBe('query { viewer { id } }');
  });
});
