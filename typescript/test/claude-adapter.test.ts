import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { ServiceConfig, CodexUpdateEvent } from '../src/types.js';
import { ClaudeAdapter } from '../src/agent/claude-adapter.js';
import { defaultConfig, sampleIssue } from './helpers.js';

// ── Mock child_process.spawn ──

const mockProcesses: Array<{
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  emitter: EventEmitter;
  killed: boolean;
  args: string[];
}> = [];

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[], opts: any) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const entry = { stdout, stderr, exitCode: null, emitter, killed: false, args };

    const proc = {
      stdout,
      stderr,
      stdin: null,
      killed: false,
      kill(signal: string) {
        entry.killed = true;
        emitter.emit('exit', signal === 'SIGKILL' ? -9 : 0);
      },
      once(event: string, fn: (...a: unknown[]) => void) {
        emitter.once(event, fn);
        return proc;
      },
      on(event: string, fn: (...a: unknown[]) => void) {
        emitter.on(event, fn);
        return proc;
      },
      removeListener(event: string, fn: (...a: unknown[]) => void) {
        emitter.removeListener(event, fn);
        return proc;
      },
    };

    mockProcesses.push(entry);

    // Auto-exit for --version check (stdio: 'ignore' => no stdout/stderr needed)
    if (args.includes('--version')) {
      setImmediate(() => emitter.emit('exit', 0));
    }

    return proc as unknown as ChildProcess;
  },
}));

function lastProcess() {
  return mockProcesses[mockProcesses.length - 1];
}

function emitStreamLine(proc: typeof mockProcesses[number], line: string) {
  proc.stdout.write(line + '\n');
}

function emitExit(proc: typeof mockProcesses[number], code: number | null) {
  proc.emitter.emit('exit', code);
}

// ── Tests ──

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;
  let config: ServiceConfig;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
    config = defaultConfig({ agent: { kind: 'claude', maxConcurrentAgents: 10, maxTurns: 20, maxRetryBackoffMs: 300000, maxConcurrentAgentsByState: {} } });
    mockProcesses.length = 0;
  });

  // ── startSession ──

  describe('startSession', () => {
    it('returns a session with workspace and no process', async () => {
      // The --version check spawns a process; let it exit cleanly
      const result = await adapter.startSession('/tmp/workspace', config);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.workspace).toBe('/tmp/workspace');
      expect(result.value.process).toBeNull();
    });
  });

  // ── runTurn ──

  describe('runTurn', () => {
    it('spawns claude with correct args', async () => {
      const session = { process: null, workspace: '/tmp/ws' };
      const events: CodexUpdateEvent[] = [];
      const onMessage = (e: CodexUpdateEvent) => events.push(e);

      const turnPromise = adapter.runTurn(session, 'Fix the bug', sampleIssue(), config, onMessage);

      // Wait for spawn
      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();
      expect(proc.args).toContain('-p');
      expect(proc.args).toContain('Fix the bug');
      expect(proc.args).toContain('--output-format');
      expect(proc.args).toContain('stream-json');

      // Simulate claude output
      emitStreamLine(proc, JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'Working on it' }] }));
      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'sess-1' }));
      emitExit(proc, 0);

      const result = await turnPromise;
      expect(result.ok).toBe(true);
    });

    it('emits turn_completed on success result', async () => {
      const session = { process: null, workspace: '/tmp/ws' };
      const events: CodexUpdateEvent[] = [];
      const onMessage = (e: CodexUpdateEvent) => events.push(e);

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), config, onMessage);

      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'success', result: 'completed', session_id: 'abc' }));
      emitExit(proc, 0);

      const result = await turnPromise;
      expect(result.ok).toBe(true);
      expect(result.value!.success).toBe(true);

      const completed = events.find((e) => e.event === 'turn_completed');
      expect(completed).toBeDefined();
    });

    it('returns error on failed result', async () => {
      const session = { process: null, workspace: '/tmp/ws' };
      const events: CodexUpdateEvent[] = [];
      const onMessage = (e: CodexUpdateEvent) => events.push(e);

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), config, onMessage);

      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'error', result: 'something went wrong' }));
      emitExit(proc, 1);

      const result = await turnPromise;
      expect(result.ok).toBe(false);
      expect(result.error!.kind).toBe('turn_failed');
    });

    it('stores conversationId for --resume on subsequent turns', async () => {
      const session = { process: null, workspace: '/tmp/ws', conversationId: null } as any;

      // First turn
      const turn1 = adapter.runTurn(session, 'first prompt', sampleIssue(), config, () => {});
      await new Promise((r) => setTimeout(r, 10));
      const proc1 = lastProcess();
      // Should NOT have --resume on first turn
      expect(proc1.args).not.toContain('--resume');

      emitStreamLine(proc1, JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 'resume-id-123' }));
      emitExit(proc1, 0);
      await turn1;

      // session should now have conversationId
      expect(session.conversationId).toBe('resume-id-123');

      // Second turn
      const turn2 = adapter.runTurn(session, 'continue', sampleIssue(), config, () => {});
      await new Promise((r) => setTimeout(r, 10));
      const proc2 = lastProcess();
      // Should have --resume on second turn
      expect(proc2.args).toContain('--resume');
      expect(proc2.args).toContain('resume-id-123');

      emitStreamLine(proc2, JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      emitExit(proc2, 0);
      await turn2;
    });

    it('adds --dangerously-skip-permissions when configured', async () => {
      const claudeConfig = { ...config.claude, skipPermissions: true };
      const cfg = { ...config, claude: claudeConfig };
      const session = { process: null, workspace: '/tmp/ws' };

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), cfg, () => {});
      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      expect(proc.args).toContain('--dangerously-skip-permissions');

      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      emitExit(proc, 0);
      await turnPromise;
    });

    it('adds --model when configured', async () => {
      const claudeConfig = { ...config.claude, model: 'claude-sonnet-4-20250514' };
      const cfg = { ...config, claude: claudeConfig };
      const session = { process: null, workspace: '/tmp/ws' };

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), cfg, () => {});
      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      expect(proc.args).toContain('--model');
      expect(proc.args).toContain('claude-sonnet-4-20250514');

      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      emitExit(proc, 0);
      await turnPromise;
    });

    it('adds --max-turns when maxTurnsPerInvocation is set', async () => {
      const claudeConfig = { ...config.claude, maxTurnsPerInvocation: 3 };
      const cfg = { ...config, claude: claudeConfig };
      const session = { process: null, workspace: '/tmp/ws' };

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), cfg, () => {});
      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      expect(proc.args).toContain('--max-turns');
      expect(proc.args).toContain('3');

      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      emitExit(proc, 0);
      await turnPromise;
    });

    it('does not add --max-turns when maxTurnsPerInvocation is null', async () => {
      const claudeConfig = { ...config.claude, maxTurnsPerInvocation: null };
      const cfg = { ...config, claude: claudeConfig };
      const session = { process: null, workspace: '/tmp/ws' };

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), cfg, () => {});
      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      expect(proc.args).not.toContain('--max-turns');

      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      emitExit(proc, 0);
      await turnPromise;
    });

    it('handles non-JSON lines gracefully', async () => {
      const session = { process: null, workspace: '/tmp/ws' };
      const events: CodexUpdateEvent[] = [];
      const onMessage = (e: CodexUpdateEvent) => events.push(e);

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), config, onMessage);

      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      emitStreamLine(proc, 'not json at all');
      emitStreamLine(proc, JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      emitExit(proc, 0);

      const result = await turnPromise;
      expect(result.ok).toBe(true);
      // Should not have crashed on the non-JSON line
    });

    it('handles process exit without result event (clean exit)', async () => {
      const session = { process: null, workspace: '/tmp/ws' };
      const events: CodexUpdateEvent[] = [];
      const onMessage = (e: CodexUpdateEvent) => events.push(e);

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), config, onMessage);

      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      // Process exits cleanly but didn't send a result event
      emitExit(proc, 0);

      const result = await turnPromise;
      expect(result.ok).toBe(true);
      expect(result.value!.success).toBe(true);
    });

    it('handles process exit with non-zero code as failure', async () => {
      const session = { process: null, workspace: '/tmp/ws' };
      const events: CodexUpdateEvent[] = [];
      const onMessage = (e: CodexUpdateEvent) => events.push(e);

      const turnPromise = adapter.runTurn(session, 'test', sampleIssue(), config, onMessage);

      await new Promise((r) => setTimeout(r, 10));
      const proc = lastProcess();

      emitExit(proc, 1);

      const result = await turnPromise;
      expect(result.ok).toBe(false);
      expect(result.error!.kind).toBe('turn_failed');
    });
  });

  // ── stopSession ──

  describe('stopSession', () => {
    it('is a no-op for session with no process', () => {
      const session = { process: null, workspace: '/tmp/ws' };
      // Should not throw
      adapter.stopSession(session);
    });
  });
});
