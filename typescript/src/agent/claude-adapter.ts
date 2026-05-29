// ClaudeAdapter — spawns `claude -p` as a subprocess per turn.
// Uses --resume for multi-turn continuity and --output-format stream-json
// for structured event parsing.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Result, ServiceConfig, Issue, CodexUpdateEvent, CodexUsage } from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';
import type { AgentAdapter, AgentSession, TurnResult } from './adapter.js';

// ── Claude-specific session ──

interface ClaudeSession extends AgentSession {
  conversationId: string | null;
}

// ── Stream-json event types from Claude CLI ──

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  content?: Array<{ type: string; text?: string }>;
  message?: unknown;
}

// ── Adapter ──

export class ClaudeAdapter implements AgentAdapter {

  // ── startSession ──
  // Validate that `claude` binary exists on PATH, then return a lightweight session.
  // No long-lived process — Claude CLI is invoked per-turn.

  async startSession(
    workspace: string,
    _config: ServiceConfig,
    _dynamicTools?: unknown[],
  ): Promise<Result<AgentSession>> {
    // Validate claude binary is available
    const checkResult = await checkBinary('claude');
    if (!checkResult.ok) {
      return { ok: false, error: new TypedError('claude_not_found', 'claude binary not found on PATH') };
    }

    const session: ClaudeSession = {
      process: null,
      workspace,
      conversationId: null,
    };

    return { ok: true, value: session };
  }

  // ── runTurn ──
  // Spawn `claude -p <prompt>` with appropriate flags, parse stream-json output.

  async runTurn(
    session: AgentSession,
    prompt: string,
    issue: Issue,
    config: ServiceConfig,
    onMessage: (event: CodexUpdateEvent) => void,
  ): Promise<Result<TurnResult>> {
    const claudeSession = session as ClaudeSession;
    const claudeConfig = config.claude;

    const args = buildClaudeArgs(prompt, claudeSession, claudeConfig);

    logger.debug('Spawning claude process', { args: args.join(' '), workspace: session.workspace });

    const proc = spawn(claudeConfig.command, args, {
      cwd: session.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    if (!proc.stdout) {
      proc.kill('SIGKILL');
      return { ok: false, error: new TypedError('spawn_failed', 'Failed to create stdout pipe for claude') };
    }

    // Emit session_started with a synthetic session ID
    const sessionId = claudeSession.conversationId ?? `claude-${Date.now()}`;
    emit(onMessage, 'session_started', { session_id: sessionId });

    return receiveStreamLoop(proc, claudeSession, claudeConfig.turnTimeoutMs, onMessage);
  }

  // ── stopSession ──
  // No-op: the process exits after each turn. Kill any lingering process just in case.

  stopSession(session: AgentSession): void {
    if (session.process && !session.process.killed) {
      try {
        session.process.kill('SIGTERM');
      } catch {
        // already dead
      }
    }
  }
}

// ── Helpers ──

function buildClaudeArgs(
  prompt: string,
  session: ClaudeSession,
  config: ServiceConfig['claude'],
): string[] {
  const args: string[] = ['-p', prompt, '--output-format', 'stream-json'];

  if (session.conversationId) {
    args.push('--resume', session.conversationId);
  }

  if (config.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.maxTurnsPerInvocation != null && config.maxTurnsPerInvocation > 0) {
    args.push('--max-turns', String(config.maxTurnsPerInvocation));
  }

  if (config.systemPrompt) {
    args.push('--system-prompt', config.systemPrompt);
  }

  return args;
}

async function checkBinary(name: string): Promise<Result<void>> {
  return new Promise((resolve) => {
    const proc = spawn(name, ['--version'], { stdio: 'ignore' });
    proc.on('error', () => {
      resolve({ ok: false, error: new TypedError('claude_not_found', `${name} not found`) });
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true, value: undefined });
      } else {
        // --version may return non-zero but still exist; treat as available
        resolve({ ok: true, value: undefined });
      }
    });
    // Timeout fallback
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: true, value: undefined });
    }, 5000);
  });
}

async function receiveStreamLoop(
  proc: ChildProcess,
  session: ClaudeSession,
  timeoutMs: number,
  onMessage: (event: CodexUpdateEvent) => void,
): Promise<Result<TurnResult>> {
  return new Promise<Result<TurnResult>>((resolve) => {
    let settled = false;
    let buffer = '';

    const turnTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ ok: false, error: new TypedError('turn_timeout', `claude turn timed out after ${timeoutMs}ms`) });
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(turnTimer);
      proc.stdout?.removeListener('data', onData);
      proc.stderr?.removeListener('data', onStderr);
      proc.removeListener('exit', onExit);
    };

    const onExit = (code: number | null) => {
      if (!settled) {
        settled = true;
        cleanup();
        if (code === 0) {
          // Process exited cleanly without emitting a result event — treat as completed
          emit(onMessage, 'turn_completed', { payload: { exit_code: code } });
          resolve({ ok: true, value: { success: true, reason: 'process_exited_clean' } });
        } else {
          resolve({ ok: false, error: new TypedError('turn_failed', `claude process exited with code ${code}`) });
        }
      }
    };

    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text.length === 0) return;
      logger.debug('Claude stderr', { output: text.slice(0, 500) });
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const result = handleStreamLine(trimmed, session, onMessage);
        if (result !== undefined) {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(result);
          }
          return;
        }
      }
    };

    proc.once('exit', onExit);
    proc.stderr?.on('data', onStderr);
    proc.stdout?.on('data', onData);
  });
}

type StreamResult = Result<TurnResult> | undefined;

function handleStreamLine(
  line: string,
  session: ClaudeSession,
  onMessage: (event: CodexUpdateEvent) => void,
): StreamResult {
  let event: ClaudeStreamEvent;
  try {
    event = JSON.parse(line) as ClaudeStreamEvent;
  } catch {
    if (line.trimStart().startsWith('{')) {
      emit(onMessage, 'malformed', { payload: { raw: line } });
    } else {
      logger.debug('Claude stdout (non-json)', { output: line.slice(0, 500) });
    }
    return undefined;
  }

  switch (event.type) {
    case 'result': {
      // Terminal event — extract session_id for resume, resolve the turn
      if (event.session_id) {
        session.conversationId = event.session_id;
      }

      const usage = extractUsage(event);

      if (event.subtype === 'error' || event.subtype === 'error_tool_use') {
        emit(onMessage, 'turn_failed', { payload: event as unknown as Record<string, unknown> });
        return { ok: false, error: new TypedError('turn_failed', `claude turn failed: ${event.result ?? 'unknown'}`) };
      }

      emit(onMessage, 'turn_completed', { payload: event as unknown as Record<string, unknown>, usage });
      return {
        ok: true,
        value: {
          success: true,
          reason: 'turn_completed',
          tokens: usage,
        },
      };
    }

    case 'assistant': {
      const text = extractTextContent(event);
      emit(onMessage, 'notification', {
        message: text,
        payload: event as unknown as Record<string, unknown>,
      });
      return undefined;
    }

    case 'tool_use':
    case 'tool_result': {
      emit(onMessage, 'notification', {
        message: `${event.type}: ${event.subtype ?? ''}`,
        payload: event as unknown as Record<string, unknown>,
      });
      return undefined;
    }

    default: {
      emit(onMessage, 'notification', {
        payload: event as unknown as Record<string, unknown>,
      });
      return undefined;
    }
  }
}

function extractTextContent(event: ClaudeStreamEvent): string {
  if (!Array.isArray(event.content)) return '';
  return event.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}

function extractUsage(event: ClaudeStreamEvent): { input: number; output: number; total: number } | undefined {
  // Claude CLI stream-json does not expose token counts directly.
  // We report 0 tokens — cost_usd is available in the payload for observability.
  return undefined;
}

function emit(
  onMessage: (event: CodexUpdateEvent) => void,
  event: string,
  details: Record<string, unknown>,
): void {
  onMessage({ event, timestamp: new Date(), ...details });
}
