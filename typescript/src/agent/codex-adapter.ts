// CodexAdapter — thin wrapper around the existing app-server module.
// Adapts the Codex-specific Session/TurnResult types to the generic AgentAdapter contract.

import type { Result, ServiceConfig, Issue, CodexUpdateEvent } from '../types.js';
import type { AgentAdapter, AgentSession, TurnResult } from './adapter.js';
import {
  startSession as codexStart,
  runTurn as codexRun,
  stopSession as codexStop,
  type Session,
} from './app-server.js';

export class CodexAdapter implements AgentAdapter {
  async startSession(
    workspace: string,
    config: ServiceConfig,
    dynamicTools?: unknown[],
  ): Promise<Result<AgentSession>> {
    const result = await codexStart(workspace, config, dynamicTools);
    if (!result.ok) return result;
    return { ok: true, value: this.toGeneric(result.value) };
  }

  async runTurn(
    session: AgentSession,
    prompt: string,
    issue: Issue,
    config: ServiceConfig,
    onMessage: (event: CodexUpdateEvent) => void,
  ): Promise<Result<TurnResult>> {
    const codexSession = this.fromGeneric(session);
    return codexRun(codexSession, prompt, issue, config, onMessage);
  }

  stopSession(session: AgentSession): void {
    codexStop(this.fromGeneric(session));
  }

  // ── Cast helpers ──

  // Codex Session has all AgentSession fields plus extras — safe upcast.
  private toGeneric(s: Session): AgentSession {
    return { process: s.process, workspace: s.workspace };
  }

  // We stored a Codex Session earlier; recover it via the extra fields.
  // The runner only ever passes sessions back that we created.
  private fromGeneric(s: AgentSession): Session {
    return s as unknown as Session;
  }
}
