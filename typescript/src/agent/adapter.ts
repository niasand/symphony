// AgentAdapter — pluggable interface for coding agent backends.
// Codex and Claude implement this contract; the runner selects via config.

import type { ChildProcess } from 'node:child_process';
import type { Result, ServiceConfig, Issue, CodexUpdateEvent } from '../types.js';
import { CodexAdapter } from './codex-adapter.js';
import { ClaudeAdapter } from './claude-adapter.js';

// ── Shared session base ──

export interface AgentSession {
  process: ChildProcess | null;
  workspace: string;
}

// ── Turn result (returned by both adapters) ──

export interface TurnResult {
  success: boolean;
  reason: string;
  tokens?: { input: number; output: number; total: number };
}

// ── Adapter contract ──

export interface AgentAdapter {
  startSession(
    workspace: string,
    config: ServiceConfig,
    dynamicTools?: unknown[],
  ): Promise<Result<AgentSession>>;

  runTurn(
    session: AgentSession,
    prompt: string,
    issue: Issue,
    config: ServiceConfig,
    onMessage: (event: CodexUpdateEvent) => void,
  ): Promise<Result<TurnResult>>;

  stopSession(session: AgentSession): void;
}

// ── Factory ──

export function createAdapter(kind: string): AgentAdapter {
  switch (kind) {
    case 'claude':
      return new ClaudeAdapter();
    case 'codex':
    default:
      return new CodexAdapter();
  }
}
