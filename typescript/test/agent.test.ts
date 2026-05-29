import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import type { ServiceConfig, Issue } from '../src/types.js';
import { startSession, runTurn, stopSession, type Session } from '../src/agent/app-server.js';
import { METHODS } from '../src/agent/protocol.js';

// ── Mock stream / process ──

/** Real Readable so `readline.createInterface` can use it. */
class MockStdout extends Readable {
  override _read() { /* push-driven */ }
}

interface MockProc {
  stdin: InstanceType<typeof Writable>;
  stdout: MockStdout;
  stderr: MockStdout;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  pid: number;
  _chunks: string[];
}

function makeProc(): MockProc {
  const chunks: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stdin,
    stdout: new MockStdout(),
    stderr: new MockStdout(),
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    pid: 12345,
    _chunks: chunks,
  };
}

function send(proc: MockProc, msg: Record<string, unknown>): void {
  proc.stdout.push(Buffer.from(JSON.stringify(msg) + '\n'));
}

function sendRaw(proc: MockProc, text: string): void {
  proc.stdout.push(Buffer.from(text + '\n'));
}

function sentMessages(proc: MockProc): Record<string, unknown>[] {
  return proc._chunks.join('').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
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

const ISSUE: Issue = {
  id: 'i1', identifier: 'T-1', title: 'Test', description: null,
  priority: 1, state: 'In Progress', branch_name: null, url: null,
  labels: [], blocked_by: [], created_at: null, updated_at: null, assignee_id: null,
};

// ── Spawn mock ──

let proc: MockProc;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    proc = makeProc();
    return proc;
  }),
}));

// ── Timing helpers ──

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function handshake(p: MockProc, threadId = 'thread-test'): void {
  setTimeout(() => send(p, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-04-21', capabilities: {}, serverInfo: { name: 'fake' } } }), 0);
  setTimeout(() => send(p, { jsonrpc: '2.0', id: 2, result: { thread: { id: threadId } } }), 0);
}

async function startOk(overrides?: Partial<ServiceConfig['codex']>): Promise<{ s: Session; cfg: ServiceConfig }> {
  const cfg = makeConfig(overrides);
  const p = startSession('/tmp/ws', cfg);
  handshake(proc);
  const r = await p;
  if (!r.ok) throw new Error(r.error.message);
  await tick();
  return { s: r.value, cfg };
}

async function startTurn(
  s: Session,
  cfg: ServiceConfig,
): Promise<{ events: unknown[]; turnP: Promise<ReturnType<typeof runTurn>> }> {
  const events: unknown[] = [];
  const turnP = runTurn(s, 'hello', ISSUE, cfg, (e) => events.push(e));
  await tick();
  // respond to turn/start (id=3)
  send(proc, { jsonrpc: '2.0', id: 3, result: { turn: { id: 'turn-test' } } });
  await tick();
  return { events, turnP };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe('Codex app-server client', () => {

  // ── startSession ──

  describe('startSession', () => {
    it('succeeds when codex responds to initialize + thread/start', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      handshake(proc, 'thread-abc');

      const r = await p;
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.threadId).toBe('thread-abc');

      const msgs = sentMessages(proc);
      expect(msgs).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'initialize', id: 1 }),
        expect.objectContaining({ method: 'initialized' }),
        expect.objectContaining({ method: 'thread/start', id: 2 }),
      ]));
      stopSession(r.value);
    });

    it('fails with response_timeout when codex never responds', async () => {
      const cfg = makeConfig({ readTimeoutMs: 50 });
      const r = await startSession('/tmp/ws', cfg);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('response_timeout');
    });

    it('fails with response_error when initialize returns JSON-RPC error', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      setTimeout(() => send(proc, { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } }), 0);
      const r = await p;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('response_error');
        expect(r.error.message).toContain('JSON-RPC error');
      }
    });

    it('fails with response_error when thread/start has no thread.id', async () => {
      const cfg = makeConfig();
      const p = startSession('/tmp/ws', cfg);
      setTimeout(() => send(proc, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-04-21', capabilities: {}, serverInfo: { name: 'fake' } } }), 0);
      setTimeout(() => send(proc, { jsonrpc: '2.0', id: 2, result: {} }), 0);
      const r = await p;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('response_error');
        expect(r.error.message).toContain('invalid thread payload');
      }
    });
  });

  // ── runTurn ──

  describe('runTurn', () => {
    it('returns success on turn/completed', async () => {
      const { s, cfg } = await startOk();
      const { events, turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });
      const r = await turnP;

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.success).toBe(true);
        expect(r.value.reason).toBe('turn_completed');
      }
      expect(events.some((e) => (e as Record<string, unknown>).event === 'session_started')).toBe(true);
      stopSession(s);
    });

    it('returns turn_failed on turn/failed', async () => {
      const { s, cfg } = await startOk();
      const { events, turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', method: 'turn/failed', params: { reason: 'err' } });
      const r = await turnP;

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('turn_failed');
      expect(events.some((e) => (e as Record<string, unknown>).event === 'turn_failed')).toBe(true);
      stopSession(s);
    });

    it('returns turn_cancelled on turn/cancelled', async () => {
      const { s, cfg } = await startOk();
      const { turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', method: 'turn/cancelled', params: {} });
      const r = await turnP;

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('turn_cancelled');
      stopSession(s);
    });

    it('returns turn_timeout when codex stalls', async () => {
      const { s, cfg } = await startOk({ turnTimeoutMs: 50 });
      const { turnP } = await startTurn(s, cfg);
      // never send turn/completed
      const r = await turnP;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('turn_timeout');
      stopSession(s);
    });

    it('returns response_error when turn/start responds with error', async () => {
      const { s, cfg } = await startOk();
      const events: unknown[] = [];
      const turnP = runTurn(s, 'hello', ISSUE, cfg, (e) => events.push(e));
      await tick();

      send(proc, { jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'thread not found' } });

      const r = await turnP;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('response_error');
      stopSession(s);
    });
  });

  // ── Approval handling ──

  describe('approval handling (autoApprove = true)', () => {
    it('auto-approves command execution requests', async () => {
      const { s, cfg } = await startOk();
      const { events, turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', id: 100, method: METHODS.COMMAND_EXECUTION_APPROVAL, params: { command: 'npm test' } });
      await tick();
      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const r = await turnP;
      expect(r.ok).toBe(true);

      const approval = sentMessages(proc).find((m) => m.id === 100 && m.result != null);
      expect(approval).toBeDefined();
      expect(approval!.result).toEqual(expect.objectContaining({ decision: 'acceptForSession' }));
      expect(events.some((e) => (e as Record<string, unknown>).event === 'approval_auto_approved')).toBe(true);
      stopSession(s);
    });

    it('auto-approves file change requests', async () => {
      const { s, cfg } = await startOk();
      const { turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', id: 101, method: METHODS.FILE_CHANGE_APPROVAL, params: { path: '/src/index.ts' } });
      await tick();
      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const r = await turnP;
      expect(r.ok).toBe(true);

      const approval = sentMessages(proc).find((m) => m.id === 101 && m.result != null);
      expect(approval).toBeDefined();
      expect(approval!.result).toEqual(expect.objectContaining({ decision: 'acceptForSession' }));
      stopSession(s);
    });

    it('uses approved_for_session for execCommandApproval', async () => {
      const { s, cfg } = await startOk();
      const { turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', id: 102, method: METHODS.EXEC_COMMAND_APPROVAL, params: {} });
      await tick();
      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      await turnP;
      const approval = sentMessages(proc).find((m) => m.id === 102 && m.result != null);
      expect(approval!.result).toEqual(expect.objectContaining({ decision: 'approved_for_session' }));
      stopSession(s);
    });
  });

  // ── Non-auto-approve ──

  describe('approval handling (autoApprove = false)', () => {
    it('fails turn when approval is required', async () => {
      const { s, cfg } = await startOk({ approvalPolicy: 'on-failure' });
      const { events, turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', id: 300, method: METHODS.COMMAND_EXECUTION_APPROVAL, params: { command: 'rm -rf /' } });

      const r = await turnP;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('unknown');
        expect(r.error.message).toContain('approval required');
      }
      expect(events.some((e) => (e as Record<string, unknown>).event === 'approval_required')).toBe(true);
      stopSession(s);
    });
  });

  // ── User input ──

  describe('user input', () => {
    it('fails turn with turn_input_required on MCP elicitation', async () => {
      const { s, cfg } = await startOk();
      const { events, turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', id: 200, method: METHODS.MCP_ELICITATION, params: { message: 'confirm' } });

      const r = await turnP;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('turn_input_required');
      expect(events.some((e) => (e as Record<string, unknown>).event === 'turn_input_required')).toBe(true);
      stopSession(s);
    });
  });

  // ── Session events ──

  describe('session events', () => {
    it('emits session_started via onMessage', async () => {
      const { s, cfg } = await startOk();
      const { events, turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const r = await turnP;
      expect(r.ok).toBe(true);

      // startTurn already captured events including session_started
      const hasStarted = events.some((e) => (e as Record<string, unknown>).event === 'session_started');
      expect(hasStarted).toBe(true);
      stopSession(s);
    });

    it('tracks token usage from thread/tokenUsage/updated', async () => {
      const { s, cfg } = await startOk();
      const { events, turnP } = await startTurn(s, cfg);

      send(proc, { jsonrpc: '2.0', method: METHODS.THREAD_TOKEN_USAGE, usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 } });
      await tick();
      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      await turnP;
      const ue = events.find((e) => (e as Record<string, unknown>).event === 'notification' && (e as Record<string, unknown>).usage != null);
      expect(ue).toBeDefined();
      const u = (ue as Record<string, unknown>).usage as Record<string, number>;
      expect(u.inputTokens).toBe(1000);
      expect(u.outputTokens).toBe(500);
      expect(u.totalTokens).toBe(1500);
      stopSession(s);
    });
  });

  // ── Malformed messages ──

  describe('malformed messages', () => {
    it('handles non-JSON lines gracefully', async () => {
      const { s, cfg } = await startOk();
      const { turnP } = await startTurn(s, cfg);

      sendRaw(proc, 'not json');
      sendRaw(proc, 'debug output');
      await tick();

      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      const r = await turnP;
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.success).toBe(true);
      stopSession(s);
    });

    it('emits malformed event for broken JSON starting with {', async () => {
      const { s, cfg } = await startOk();
      const { events, turnP } = await startTurn(s, cfg);

      sendRaw(proc, '{"broken": "json", "missing":');
      await tick();
      send(proc, { jsonrpc: '2.0', method: 'turn/completed', params: {} });

      await turnP;
      expect(events.some((e) => (e as Record<string, unknown>).event === 'malformed')).toBe(true);
      stopSession(s);
    });
  });

  // ── stopSession ──

  describe('stopSession', () => {
    it('kills the process and destroys stdin', async () => {
      const { s } = await startOk();
      const p = proc;
      stopSession(s);
      expect(p.kill).toHaveBeenCalled();
    });
  });
});
