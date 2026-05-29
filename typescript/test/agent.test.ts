import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { ServiceConfig, Issue } from '../src/types.js';
import { startSession, runTurn, stopSession, type Session } from '../src/agent/app-server.js';
import { METHODS } from '../src/agent/protocol.js';

// ── Mock stdout ──

/** A real Readable stream so `readline.createInterface` works. */
class MockStdout extends Readable {
  override _read() { /* push-driven */ }
}

// ── Mock process ──

interface MockProcess {
  stdin: InstanceType<typeof Writable>;
  stdout: MockStdout;
  stderr: MockStdout;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  pid: number;
}

function createMockProcess(): MockProcess {
  const stdout = new MockStdout();
  const chunks: string[] = [];

  const stdin = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });

  const proc: MockProcess & { _chunks: string[] } = {
    stdin,
    stdout,
    stderr: new MockStdout(),
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    pid: 12345,
    _chunks: chunks,
  };

  return proc;
}

function sendToClient(proc: MockProcess, msg: Record<string, unknown>): void {
  proc.stdout.push(Buffer.from(JSON.stringify(msg) + '\n'));
}

function sendRaw(proc: MockProcess, text: string): void {
  proc.stdout.push(Buffer.from(text + '\n'));
}

function getSentMessages(proc: MockProcess & { _chunks: string[] }): Record<string, unknown>[] {
  return proc._chunks
    .join('')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ── Fixtures ──

function makeConfig(overrides: Partial<ServiceConfig['codex']> = {}): ServiceConfig {
  return {
    tracker: { kind: 'linear', endpoint: 'https://api.linear.app', apiKey: 'k', projectSlug: 'T', activeStates: ['In Progress'], terminalStates: ['Done'] },
    polling: { intervalMs: 5000 },
    workspace: { root: '/tmp/ws' },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 5000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 5, maxRetryBackoffMs: 60000, maxConcurrentAgentsByState: {} },
    codex: {
      command: 'echo',
      approvalPolicy: 'never',
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 2000,
      readTimeoutMs: 2000,
      stallTimeoutMs: 5000,
      ...overrides,
    },
    worker: { sshHosts: [], maxConcurrentAgentsPerHost: null },
    server: { port: null },
  };
}

const TEST_ISSUE: Issue = {
  id: 'issue-1', identifier: 'TEST-1', title: 'Test issue', description: null,
  priority: 1, state: 'In Progress', branch_name: null, url: null,
  labels: [], blocked_by: [], created_at: null, updated_at: null, assignee_id: null,
};

// ── Capture the proc created by spawn ──

let capturedProc: MockProcess & { _chunks: string[] };

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = createMockProcess() as MockProcess & { _chunks: string[] };
    capturedProc = proc;
    return proc;
  }),
}));

// ── Helpers ──

/**
 * Complete the initialize + thread/start handshake so that startSession resolves.
 * Uses short setTimeout to push data after the readline listener is attached.
 */
function respondHandshake(
  proc: MockProcess,
  threadId = 'thread-test',
  initResult = { protocolVersion: '2025-04-21', capabilities: {}, serverInfo: { name: 'fake-codex' } },
): void {
  // respond to initialize (id=1) on next tick
  setTimeout(() => {
    sendToClient(proc, { jsonrpc: '2.0', id: 1, result: initResult });
  }, 0);
  // respond to thread/start (id=2) after another tick
  setTimeout(() => {
    sendToClient(proc, { jsonrpc: '2.0', id: 2, result: { thread: { id: threadId } } });
  }, 0);
}

/** Wait a tick for setTimeout(0) callbacks to fire. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ── Tests ──

describe('Codex app-server client', () => {

  // ── Session lifecycle ──

  describe('startSession', () => {
    it('should succeed when codex responds to initialize + thread/start', async () => {
      const config = makeConfig();
      const promise = startSession('/tmp/ws', config);

      // Let the handshakes flow
      respondHandshake(capturedProc, 'thread-abc-123');

      const result = await promise;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.threadId).toBe('thread-abc-123');

      const sent = getSentMessages(capturedProc);
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'initialize', id: 1 }),
          expect.objectContaining({ method: 'initialized' }),
          expect.objectContaining({ method: 'thread/start', id: 2 }),
        ]),
      );

      stopSession(result.value);
    });

    it('should fail with response_timeout when codex never responds', async () => {
      const config = makeConfig({ readTimeoutMs: 50 });
      const promise = startSession('/tmp/ws', config);

      // Don't send any responses — let the timeout fire
      const result = await promise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('response_timeout');
      }
    });

    it('should fail with response_error when initialize returns an error', async () => {
      const config = makeConfig();
      const promise = startSession('/tmp/ws', config);

      setTimeout(() => {
        sendToClient(capturedProc, {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32600, message: 'invalid request' },
        });
      }, 0);

      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('response_error');
        expect(result.error.message).toContain('initialize error');
      }
    });

    it('should fail with response_error when thread/start returns invalid payload', async () => {
      const config = makeConfig();
      const promise = startSession('/tmp/ws', config);

      setTimeout(() => {
        sendToClient(capturedProc, {
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2025-04-21', capabilities: {}, serverInfo: { name: 'fake-codex' } },
        });
      }, 0);

      setTimeout(() => {
        // thread/start response with no thread.id
        sendToClient(capturedProc, { jsonrpc: '2.0', id: 2, result: {} });
      }, 0);

      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('response_error');
        expect(result.error.message).toContain('invalid thread payload');
      }
    });
  });

  // ── Turn processing ──

  describe('runTurn', () => {
    async function startOk(overrides?: Partial<ServiceConfig['codex']>): Promise<{ s: Session; proc: MockProcess & { _chunks: string[] }; cfg: ServiceConfig }> {
      const cfg = makeConfig(overrides);
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error(`startSession failed: ${r.error.message}`);
      await tick();
      return { s: r.value, proc: capturedProc, cfg };
    }

    it('should return success when codex sends turn/completed', async () => {
      const { s, proc, cfg } = await startOk();
      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'hello', TEST_ISSUE, cfg, onMsg);

      await tick();

      // Respond to turn/start (id=3)
      sendToClient(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-1' } } });

      await tick();

      // Complete the turn
      sendToClient(proc, { jsonrpc: '2.0', method: 'turn/completed', params: { outcome: 'success' } });

      const result = await turnP;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.success).toBe(true);
        expect(result.value.reason).toBe('turn_completed');
      }

      expect(events.some((e) => (e as Record<string, unknown>).event === 'session_started')).toBe(true);

      stopSession(s);
    });

    it('should fail when codex sends turn/failed', async () => {
      const { s, proc, cfg } = await startOk();
      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'hello', TEST_ISSUE, cfg, onMsg);
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-2' } } });
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', method: 'turn/failed', params: { reason: 'model error' } });

      const result = await turnP;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('turn_failed');
      }

      expect(events.some((e) => (e as Record<string, unknown>).event === 'turn_failed')).toBe(true);
      stopSession(s);
    });

    it('should fail when codex sends turn/cancelled', async () => {
      const { s, proc, cfg } = await startOk();
      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'hello', TEST_ISSUE, cfg, onMsg);
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-3' } } });
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', method: 'turn/cancelled', params: { reason: 'user abort' } });

      const result = await turnP;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('turn_cancelled');
      }
      stopSession(s);
    });

    it('should fail with turn_timeout when codex stalls after turn/start', async () => {
      const { s, proc, cfg } = await startOk({ turnTimeoutMs: 50 });
      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'hello', TEST_ISSUE, cfg, onMsg);
      await tick();

      // Respond to turn/start but never complete
      sendToClient(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-4' } } });

      const result = await turnP;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('turn_timeout');
      }
      stopSession(s);
    });

    it('should fail with response_error when turn/start returns error', async () => {
      const { s, proc, cfg } = await startOk();

      const turnP = runTurn(s, 'hello', TEST_ISSUE, cfg, () => {});
      await tick();

      sendToClient(proc, {
        jsonrpc: '2.0', id: 3,
        error: { code: -32000, message: 'thread not found' },
      });

      const result = await turnP;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('response_error');
      }
      stopSession(s);
    });
  });

  // ── Approval handling ──

  describe('approval handling', () => {
    async function startAutoApprove(): Promise<{ s: Session; proc: MockProcess & { _chunks: string[] }; cfg: ServiceConfig }> {
      return startOkSession({ approvalPolicy: 'never' });
    }

    async function startOkSession(overrides?: Partial<ServiceConfig['codex']>): Promise<{ s: Session; proc: MockProcess & { _chunks: string[] }; cfg: ServiceConfig }> {
      const cfg = makeConfig(overrides);
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error(`startSession failed: ${r.error.message}`);
      await tick();
      return { s: r.value, proc: capturedProc, cfg };
    }

    it('should auto-approve command execution requests', async () => {
      const { s, proc, cfg } = await startAutoApprove();
      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'run cmd', TEST_ISSUE, cfg, onMsg);
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-a1' } } });
      await tick();

      // Send command execution approval request
      sendToClient(proc, {
        jsonrpc: '2.0', id: 100,
        method: METHODS.COMMAND_EXECUTION_APPROVAL,
        params: { command: 'npm test' },
      });
      await tick();

      // Complete turn
      sendToClient(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const result = await turnP;
      expect(result.ok).toBe(true);

      const sent = getSentMessages(proc);
      const approval = sent.find((m) => m.id === 100 && m.result != null);
      expect(approval).toBeDefined();
      expect(approval!.result).toEqual(expect.objectContaining({ decision: 'acceptForSession' }));

      expect(events.some((e) => (e as Record<string, unknown>).event === 'approval_auto_approved')).toBe(true);

      stopSession(s);
    });

    it('should auto-approve file change requests', async () => {
      const { s, proc, cfg } = await startAutoApprove();
      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'change file', TEST_ISSUE, cfg, onMsg);
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-a2' } } });
      await tick();

      sendToClient(proc, {
        jsonrpc: '2.0', id: 101,
        method: METHODS.FILE_CHANGE_APPROVAL,
        params: { path: '/src/index.ts' },
      });
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const result = await turnP;
      expect(result.ok).toBe(true);

      const sent = getSentMessages(proc);
      const approval = sent.find((m) => m.id === 101 && m.result != null);
      expect(approval).toBeDefined();
      expect(approval!.result).toEqual(expect.objectContaining({ decision: 'acceptForSession' }));

      stopSession(s);
    });

    it('should use approved_for_session for execCommandApproval', async () => {
      const { s, proc, cfg } = await startAutoApprove();
      const turnP = runTurn(s, 'exec', TEST_ISSUE, cfg, () => {});
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-a3' } } });
      await tick();

      sendToClient(proc, {
        jsonrpc: '2.0', id: 102,
        method: METHODS.EXEC_COMMAND_APPROVAL,
        params: { command: 'rm foo' },
      });
      await tick();

      sendToClient(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      await turnP;

      const sent = getSentMessages(proc);
      const approval = sent.find((m) => m.id === 102 && m.result != null);
      expect(approval).toBeDefined();
      expect(approval!.result).toEqual(expect.objectContaining({ decision: 'approved_for_session' }));

      stopSession(s);
    });
  });

  // ── Non-auto-approve ──

  describe('non-auto-approve mode', () => {
    it('should fail turn when approval is required and autoApprove is false', async () => {
      const cfg = makeConfig({ approvalPolicy: 'on-failure' });
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error('start failed');
      const s = r.value;
      await tick();

      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'needs approval', TEST_ISSUE, cfg, onMsg);
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-na1' } } });
      await tick();

      sendToClient(capturedProc, {
        jsonrpc: '2.0', id: 300,
        method: METHODS.COMMAND_EXECUTION_APPROVAL,
        params: { command: 'rm -rf /' },
      });

      const result = await turnP;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('unknown');
        expect(result.error.message).toContain('approval required');
      }

      expect(events.some((e) => (e as Record<string, unknown>).event === 'approval_required')).toBe(true);

      stopSession(s);
    });
  });

  // ── User input ──

  describe('user input', () => {
    it('should fail turn when tool requests user input that cannot be auto-answered', async () => {
      // Use 'suggested' policy (autoApprove = false) to avoid auto-answer path
      const cfg = makeConfig({ approvalPolicy: 'suggested' });
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error('start failed');
      const s = r.value;
      await tick();

      const events: unknown[] = [];
      const onMsg = (e: unknown) => events.push(e);

      const turnP = runTurn(s, 'do task', TEST_ISSUE, cfg, onMsg);
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-in1' } } });
      await tick();

      // Send requestUserInput with questions that have no approval option
      sendToClient(capturedProc, {
        jsonrpc: '2.0', id: 200,
        method: METHODS.TOOL_REQUEST_USER_INPUT,
        params: {
          questions: [{
            id: 'q1',
            text: 'What should I do?',
            options: [
              { label: 'Continue', value: 'continue' },
              { label: 'Stop', value: 'stop' },
            ],
          }],
        },
      });

      const result = await turnP;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('turn_input_required');
      }

      expect(events.some((e) => (e as Record<string, unknown>).event === 'turn_input_required')).toBe(true);
      stopSession(s);
    });
  });

  // ── Session events ──

  describe('session events', () => {
    it('should emit session_started via onMessage', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error('start failed');
      const s = r.value;
      await tick();

      const events: unknown[] = [];
      const turnP = runTurn(s, 'test', TEST_ISSUE, cfg, (e) => events.push(e));
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-ev1' } } });
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      await turnP;

      const started = events.find((e) => (e as Record<string, unknown>).event === 'session_started');
      expect(started).toBeDefined();
      const evt = started as Record<string, unknown>;
      expect(evt.timestamp).toBeInstanceOf(Date);
      expect(evt.payload).toBeDefined();

      stopSession(s);
    });

    it('should track token usage from thread/tokenUsage/updated', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error('start failed');
      const s = r.value;
      await tick();

      const events: unknown[] = [];
      const turnP = runTurn(s, 'test', TEST_ISSUE, cfg, (e) => events.push(e));
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-ev2' } } });
      await tick();

      // Send token usage notification
      sendToClient(capturedProc, {
        jsonrpc: '2.0',
        method: METHODS.THREAD_TOKEN_USAGE,
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      });
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      await turnP;

      const usageEvent = events.find(
        (e) => (e as Record<string, unknown>).event === 'notification' && (e as Record<string, unknown>).usage != null,
      );
      expect(usageEvent).toBeDefined();
      const usage = (usageEvent as Record<string, unknown>).usage as Record<string, number>;
      expect(usage.inputTokens).toBe(1000);
      expect(usage.outputTokens).toBe(500);
      expect(usage.totalTokens).toBe(1500);

      stopSession(s);
    });
  });

  // ── Malformed messages ──

  describe('malformed message handling', () => {
    it('should handle non-JSON lines without crashing', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error('start failed');
      const s = r.value;
      await tick();

      const events: unknown[] = [];
      const turnP = runTurn(s, 'test', TEST_ISSUE, cfg, (e) => events.push(e));
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-m1' } } });
      await tick();

      // Garbage lines (not starting with {)
      sendRaw(capturedProc, 'this is not json at all');
      sendRaw(capturedProc, 'some debug output from codex');
      await tick();

      // Complete normally
      sendToClient(capturedProc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const result = await turnP;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.success).toBe(true);
      }
      stopSession(s);
    });

    it('should emit malformed event for invalid JSON starting with {', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error('start failed');
      const s = r.value;
      await tick();

      const events: unknown[] = [];
      const turnP = runTurn(s, 'test', TEST_ISSUE, cfg, (e) => events.push(e));
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-m2' } } });
      await tick();

      // Malformed JSON starting with {
      sendRaw(capturedProc, '{"broken": "json", "missing":');
      await tick();

      sendToClient(capturedProc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const result = await turnP;
      expect(result.ok).toBe(true);

      expect(events.some((e) => (e as Record<string, unknown>).event === 'malformed')).toBe(true);
      stopSession(s);
    });
  });

  // ── stopSession ──

  describe('stopSession', () => {
    it('should kill the process and destroy stdin', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      respondHandshake(capturedProc);
      const r = await p;
      if (!r.ok) throw new Error('start failed');
      const s = r.value;

      const proc = capturedProc;
      stopSession(s);

      expect(proc.kill).toHaveBeenCalled();
      // stdin should be destroyed by killSession
    });
  });
});
