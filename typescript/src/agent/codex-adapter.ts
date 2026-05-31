// CodexAdapter — wraps the existing app-server module into the AgentAdapter contract.
// Stores full Codex Session in a WeakMap keyed by the lightweight AgentSession handle.

import type { Result, ServiceConfig, Issue, CodexUpdateEvent } from '../types.js';
import { TypedError } from '../types.js';
import type { AgentAdapter, AgentSession, TurnResult } from './adapter.js';
import {
  startSession as codexStart,
  runTurn as codexRun,
  stopSession as codexStop,
  type Session,
} from './app-server.js';

// WeakMap: AgentSession handle → full Codex Session.
// GC-safe: when the handle is collected, the entry disappears.
const sessions = new WeakMap<AgentSession, Session>();

export class CodexAdapter implements AgentAdapter {
  async startSession(
    workspace: string,
    config: ServiceConfig,
    dynamicTools?: unknown[],
  ): Promise<Result<AgentSession>> {
    const result = await codexStart(workspace, config, dynamicTools);
    if (!result.ok) return result;

    // Create a lightweight handle; store full session in WeakMap.
    const handle: AgentSession = { process: result.value.process, workspace: result.value.workspace };
    sessions.set(handle, result.value);

    return { ok: true, value: handle };
  }

  async runTurn(
    session: AgentSession,
    prompt: string,
    issue: Issue,
    config: ServiceConfig,
    onMessage: (event: CodexUpdateEvent) => void,
  ): Promise<Result<TurnResult>> {
    const codexSession = sessions.get(session);
    if (!codexSession) {
      return { ok: false, error: new TypedError('spawn_failed', 'Codex session not found — was startSession called?') };
    }
    return codexRun(codexSession, prompt, issue, config, onMessage);
  }

  stopSession(session: AgentSession): void {
    const codexSession = sessions.get(session);
    if (codexSession) {
      codexStop(codexSession);
      sessions.delete(session);
    }
  }
}
