// AgentAdapter — pluggable interface for coding agent backends.
// Codex implements this contract; the runner selects via config.
//
// Session safety: each adapter stores its full session in a private WeakMap,
// keyed by the lightweight AgentSession handle returned to the runner.
// No `as unknown as` casts needed — the handle is a real AgentSession,
// and the adapter recovers its internal session via WeakMap lookup.

import type { ChildProcess } from 'node:child_process';
import type { Result, ServiceConfig, Issue, CodexUpdateEvent } from '../types.js';
import { CodexAdapter } from './codex-adapter.js';

// ── Shared session handle (returned to runner) ──

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

export function createAdapter(_kind: string): AgentAdapter {
  return new CodexAdapter();
}
