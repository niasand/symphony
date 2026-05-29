import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Result, ServiceConfig, Issue, CodexUpdateEvent, CodexUsage } from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';
import { METHODS, type JsonRpcRequest, type JsonRpcNotification, type JsonRpcResponse } from './protocol.js';
import { executeLinearGraphql } from './tools/linear-graphql.js';

// ── Session ──

export interface ToolHandler {
  execute: (input: unknown, config: ServiceConfig) => Promise<{ success: boolean; output: unknown }>;
}

export interface Session {
  process: ChildProcess;
  readline: ReadlineInterface;
  threadId: string;
  workspace: string;
  nextId: number;
  autoApprove: boolean;
  approvalPolicy: string | null;
  turnSandboxPolicy: string | null;
  toolHandlers: Map<string, ToolHandler>;
  config: ServiceConfig;
  pendingResolve: Map<number, { timer: NodeJS.Timeout }>;
}

export interface TurnResult {
  success: boolean;
  reason: string;
  tokens?: { input: number; output: number; total: number };
}

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const NON_INTERACTIVE_ANSWER = 'This is a non-interactive session. Operator input is unavailable.';

// ── startSession ──

export async function startSession(
  workspace: string,
  config: ServiceConfig,
  dynamicTools: unknown[] = [],
): Promise<Result<Session>> {
  const proc = spawn('bash', ['-lc', config.codex.command], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  if (!proc.stdin || !proc.stdout) {
    proc.kill('SIGKILL');
    return { ok: false, error: new TypedError('spawn_failed', 'Failed to create stdio pipes') };
  }

  const readline = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const pendingResolve: Session['pendingResolve'] = new Map();

  const autoApprove = config.codex.approvalPolicy === 'never';

  // Build tool handler registry from dynamicTools
  const toolHandlers = new Map<string, ToolHandler>();
  for (const spec of dynamicTools) {
    if (typeof spec === 'object' && spec !== null && 'name' in spec) {
      const name = (spec as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name === 'linear_graphql') {
        toolHandlers.set(name, { execute: executeLinearGraphql });
      }
    }
  }

  const partialSession = {
    process: proc,
    readline,
    threadId: '' as string,
    workspace,
    nextId: THREAD_START_ID + 1,
    autoApprove,
    approvalPolicy: config.codex.approvalPolicy,
    turnSandboxPolicy: config.codex.turnSandboxPolicy,
    toolHandlers,
    config,
    pendingResolve,
  };

  // ── initialize ──

  sendRequest(partialSession, METHODS.INITIALIZE, INITIALIZE_ID, {
    capabilities: { experimentalApi: true },
    clientInfo: { name: 'symphony-orchestrator', title: 'Symphony Orchestrator', version: '0.1.0' },
  });

  const initResult = await waitForResponse(partialSession, INITIALIZE_ID, config.codex.readTimeoutMs);
  if (!initResult.ok) {
    killSession(partialSession);
    return { ok: false, error: initResult.error };
  }

  if (initResult.value.error) {
    killSession(partialSession);
    return { ok: false, error: new TypedError('response_error', `initialize error: ${initResult.value.error.message}`, initResult.value.error) };
  }

  // ── initialized notification ──

  sendNotification(partialSession, METHODS.INITIALIZED, {});

  // ── thread/start ──

  sendRequest(partialSession, METHODS.THREAD_START, THREAD_START_ID, {
    approvalPolicy: config.codex.approvalPolicy,
    sandbox: config.codex.threadSandbox,
    cwd: workspace,
    dynamicTools,
  });

  const threadResult = await waitForResponse(partialSession, THREAD_START_ID, config.codex.readTimeoutMs);
  if (!threadResult.ok) {
    killSession(partialSession);
    return { ok: false, error: threadResult.error };
  }

  if (threadResult.value.error) {
    killSession(partialSession);
    return { ok: false, error: new TypedError('response_error', `thread/start error: ${threadResult.value.error.message}`, threadResult.value.error) };
  }

  const threadPayload = (threadResult.value.result as Record<string, unknown>)?.['thread'] as Record<string, unknown> | undefined;
  const threadId = threadPayload?.['id'] as string | undefined;
  if (!threadId) {
    killSession(partialSession);
    return { ok: false, error: new TypedError('response_error', `invalid thread payload from thread/start`) };
  }

  const session: Session = { ...partialSession, threadId };

  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      logger.warn('Codex process exited', { exit_code: code });
    }
  });

  return { ok: true, value: session };
}

// ── runTurn ──

export async function runTurn(
  session: Session,
  prompt: string,
  issue: Issue,
  config: ServiceConfig,
  onMessage: (event: CodexUpdateEvent) => void,
): Promise<Result<TurnResult>> {
  const turnId = session.nextId++;

  sendRequest(session, METHODS.TURN_START, turnId, {
    threadId: session.threadId,
    input: [{ type: 'text', text: prompt }],
    cwd: session.workspace,
    title: `${issue.identifier}: ${issue.title}`,
    approvalPolicy: session.approvalPolicy,
    sandboxPolicy: session.turnSandboxPolicy,
  });

  const startResult = await waitForResponse(session, turnId, config.codex.readTimeoutMs);
  if (!startResult.ok) {
    return { ok: false, error: startResult.error };
  }

  if (startResult.value.error) {
    return { ok: false, error: new TypedError('response_error', `turn/start error: ${startResult.value.error.message}`, startResult.value.error) };
  }

  const turnResponse = startResult.value.result as Record<string, unknown> | undefined;
  const actualTurnId = (turnResponse as Record<string, unknown>)?.['turn'] != null
    ? ((turnResponse as Record<string, unknown>)['turn'] as Record<string, unknown>)['id'] as string
    : undefined;
  const sessionId = actualTurnId ? `${session.threadId}-${actualTurnId}` : session.threadId;

  emit(onMessage, 'session_started', { session_id: sessionId, thread_id: session.threadId, turn_id: actualTurnId });

  return receiveTurnLoop(session, config.codex.turnTimeoutMs, onMessage);
}

// ── stopSession ──

export function stopSession(session: Session): void {
  killSession(session);
}

// ── receive loop ──

async function receiveTurnLoop(
  session: Session,
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
        resolve({ ok: false, error: new TypedError('turn_timeout', `turn timed out after ${timeoutMs}ms`) });
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(turnTimer);
      session.process.stdout?.removeListener('data', onData);
      session.process.removeListener('exit', onExit);
    };

    const onExit = (code: number | null) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ ok: false, error: new TypedError('port_exit', `codex process exited with code ${code}`) });
      }
    };

    session.process.once('exit', onExit);

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      (async () => {
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          const result = await handleLine(session, trimmed, onMessage);
          if (result !== undefined) {
            if (!settled) {
              settled = true;
              cleanup();
              resolve(result);
            }
            return;
          }
        }
      })().catch((err) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve({ ok: false, error: new TypedError('unknown', `line handling error: ${String(err)}`) });
        }
      });
    };

    session.process.stdout?.on('data', onData);
  });
}

type Handled = Result<TurnResult> | undefined;

async function handleLine(
  session: Session,
  line: string,
  onMessage: (event: CodexUpdateEvent) => void,
): Promise<Handled> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    if (line.trimStart().startsWith('{')) {
      emit(onMessage, 'malformed', { payload: line, raw: line });
    } else {
      logStreamLine(line, 'turn stream');
    }
    return undefined;
  }

  const method = parsed['method'] as string | undefined;
  if (typeof method !== 'string') return undefined;

  switch (method) {
    case METHODS.TURN_COMPLETED:
      emit(onMessage, 'turn_completed', { payload: parsed, raw: line, details: parsed });
      return { ok: true, value: { success: true, reason: 'turn_completed' } };

    case METHODS.TURN_FAILED: {
      const params = parsed['params'] as Record<string, unknown> | undefined;
      emit(onMessage, 'turn_failed', { payload: parsed, raw: line, details: params });
      return { ok: false, error: new TypedError('turn_failed', `turn failed: ${JSON.stringify(params)}`, params) };
    }

    case METHODS.TURN_CANCELLED: {
      const params = parsed['params'] as Record<string, unknown> | undefined;
      emit(onMessage, 'turn_cancelled', { payload: parsed, raw: line, details: params });
      return { ok: false, error: new TypedError('turn_cancelled', `turn cancelled: ${JSON.stringify(params)}`, params) };
    }

    case METHODS.COMMAND_EXECUTION_APPROVAL:
    case METHODS.FILE_CHANGE_APPROVAL:
    case METHODS.EXEC_COMMAND_APPROVAL:
    case METHODS.APPLY_PATCH_APPROVAL:
      return handleApproval(session, parsed, line, onMessage);

    case METHODS.TOOL_CALL:
      return await handleToolCall(session, parsed, line, onMessage);

    case METHODS.TOOL_REQUEST_USER_INPUT:
      return handleToolRequestUserInput(session, parsed, line, onMessage);

    case METHODS.MCP_ELICITATION:
      emit(onMessage, 'turn_input_required', { payload: parsed, raw: line });
      return { ok: false, error: new TypedError('turn_input_required', 'mcpServer elicitation requires input') };

    case METHODS.THREAD_TOKEN_USAGE:
      handleTokenUsage(parsed, onMessage);
      return undefined;

    default:
      if (needsInput(method, parsed)) {
        emit(onMessage, 'turn_input_required', { payload: parsed, raw: line });
        return { ok: false, error: new TypedError('turn_input_required', `method ${method} requires input`) };
      }
      emit(onMessage, 'notification', { payload: parsed, raw: line });
      logger.debug(`Codex notification: ${method}`);
      return undefined;
  }
}

// ── approval handling ──

function handleApproval(
  session: Session,
  payload: Record<string, unknown>,
  raw: string,
  onMessage: (event: CodexUpdateEvent) => void,
): Handled {
  const id = payload['id'];
  if (typeof id !== 'number') return undefined;

  if (!session.autoApprove) {
    emit(onMessage, 'approval_required', { payload, raw });
    return { ok: false, error: new TypedError('unknown', `approval required for ${payload['method']}`, payload) };
  }

  const method = payload['method'] as string;
  const decision = (method === METHODS.EXEC_COMMAND_APPROVAL || method === METHODS.APPLY_PATCH_APPROVAL)
    ? 'approved_for_session'
    : 'acceptForSession';

  sendResponse(session, id, { decision });
  emit(onMessage, 'approval_auto_approved', { payload, raw, decision });

  return undefined;
}

// ── tool call handling ──

async function handleToolCall(
  session: Session,
  payload: Record<string, unknown>,
  raw: string,
  onMessage: (event: CodexUpdateEvent) => void,
): Promise<Handled> {
  const id = payload['id'];
  if (typeof id !== 'number') return undefined;

  const params = (payload['params'] ?? {}) as Record<string, unknown>;
  const toolName = extractToolName(params);
  const arguments_ = extractToolArguments(params);

  // Dispatch to registered tool handler
  if (toolName != null && session.toolHandlers.has(toolName)) {
    const handler = session.toolHandlers.get(toolName)!;
    try {
      const execResult = await handler.execute(arguments_, session.config);
      const result = {
        success: execResult.success,
        output: JSON.stringify(execResult.output),
        contentItems: [{ type: 'inputText' as const, text: JSON.stringify(execResult.output) }],
      };
      sendResponse(session, id, result);
      emit(onMessage, 'tool_call_completed', { payload, raw, toolName, success: execResult.success });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const result = {
        success: false,
        output: JSON.stringify({ error: `tool execution error: ${errorMsg}` }),
        contentItems: [{ type: 'inputText' as const, text: `tool execution error: ${errorMsg}` }],
      };
      sendResponse(session, id, result);
      emit(onMessage, 'unsupported_tool_call', { payload, raw, toolName, error: errorMsg });
    }
    return undefined;
  }

  // Unknown tool call
  const result = toolName != null
    ? { success: false, output: `unsupported dynamic tool call: ${toolName}`, contentItems: [{ type: 'inputText' as const, text: `unsupported dynamic tool call: ${toolName}` }] }
    : { success: false, output: 'unknown tool call', contentItems: [{ type: 'inputText' as const, text: 'unknown tool call' }] };

  sendResponse(session, id, result);

  const event = 'unsupported_tool_call';
  emit(onMessage, event, { payload, raw });

  return undefined;
}

// ── tool request user input ──

function handleToolRequestUserInput(
  session: Session,
  payload: Record<string, unknown>,
  raw: string,
  onMessage: (event: CodexUpdateEvent) => void,
): Handled {
  const id = payload['id'];
  if (typeof id !== 'number') return undefined;

  const params = (payload['params'] ?? {}) as Record<string, unknown>;

  if (session.autoApprove) {
    const answersResult = tryAutoApproveAnswers(params);
    if (answersResult != null) {
      sendResponse(session, id, { answers: answersResult });
      emit(onMessage, 'approval_auto_approved', { payload, raw, decision: 'Approve this Session' });
      return undefined;
    }
  }

  const answersResult = tryNonInteractiveAnswers(params);
  if (answersResult != null) {
    sendResponse(session, id, { answers: answersResult });
    emit(onMessage, 'tool_input_auto_answered', { payload, raw, answer: NON_INTERACTIVE_ANSWER });
    return undefined;
  }

  emit(onMessage, 'turn_input_required', { payload, raw });
  return { ok: false, error: new TypedError('turn_input_required', 'tool requested user input that cannot be auto-answered') };
}

// ── token usage ──

function handleTokenUsage(
  payload: Record<string, unknown>,
  onMessage: (event: CodexUpdateEvent) => void,
): void {
  const usage = payload['usage'] as Record<string, unknown> | undefined;
  if (usage == null) return;
  const codexUsage: CodexUsage = {
    inputTokens: typeof usage['inputTokens'] === 'number' ? usage['inputTokens'] : undefined,
    outputTokens: typeof usage['outputTokens'] === 'number' ? usage['outputTokens'] : undefined,
    totalTokens: typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : undefined,
  };
  emit(onMessage, 'notification', { payload, usage: codexUsage });
}

// ── JSON-RPC send helpers ──

function sendRequest(session: Omit<Session, 'threadId'> | Session, method: string, id: number, params: Record<string, unknown>): void {
  const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
  writeLine(session, JSON.stringify(msg));
}

function sendNotification(session: Omit<Session, 'threadId'> | Session, method: string, params: Record<string, unknown>): void {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
  writeLine(session, JSON.stringify(msg));
}

function sendResponse(session: Omit<Session, 'threadId'> | Session, id: number, result: unknown): void {
  const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
  writeLine(session, JSON.stringify(msg));
}

function writeLine(session: { process: ChildProcess }, line: string): void {
  try {
    session.process.stdin?.write(line + '\n');
  } catch (err) {
    logger.error('Failed to write to stdin', { error: String(err) });
  }
}

// ── waitForResponse ──

async function waitForResponse(
  session: Omit<Session, 'threadId'> | Session,
  id: number,
  timeoutMs: number,
): Promise<Result<JsonRpcResponse>> {
  return new Promise<Result<JsonRpcResponse>>((resolve) => {
    let handler: ((line: string) => void) | null = null;

    const timer = setTimeout(() => {
      if (handler) session.readline?.removeListener('line', handler);
      session.pendingResolve.delete(id);
      resolve({ ok: false, error: new TypedError('response_timeout', `response timeout for id=${id} after ${timeoutMs}ms`) });
    }, timeoutMs);

    handler = (line: string) => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        logStreamLine(trimmed, 'response stream');
        return;
      }

      if (parsed['id'] !== id) {
        logger.debug(`Ignoring message while waiting for response id=${id}`, { msg_id: parsed['id'] });
        return;
      }

      clearTimeout(timer);
      session.readline?.removeListener('line', handler!);
      session.pendingResolve.delete(id);

      if (parsed['error']) {
        resolve({ ok: false, error: new TypedError('response_error', `JSON-RPC error: ${JSON.stringify(parsed['error'])}`, parsed['error']) });
      } else {
        resolve({ ok: true, value: { jsonrpc: '2.0', id, result: parsed['result'] } });
      }
    };

    session.pendingResolve.set(id, { timer });
    session.readline?.on('line', handler);
  });
}

// ── session cleanup ──

function killSession(session: { process: ChildProcess; readline?: ReadlineInterface; pendingResolve: Session['pendingResolve'] }): void {
  for (const [, entry] of session.pendingResolve) {
    clearTimeout(entry.timer);
  }
  session.pendingResolve.clear();
  session.readline?.close();

  try {
    if (session.process.stdin && !session.process.stdin.destroyed) {
      session.process.stdin.destroy();
    }
  } catch { /* ignore */ }

  try {
    session.process.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      try { session.process.kill('SIGKILL'); } catch { /* already dead */ }
    }, 3000);
    forceTimer.unref();
  } catch { /* already dead */ }
}

// ── emit helper ──

function emit(onMessage: (event: CodexUpdateEvent) => void, event: string, details: Record<string, unknown>): void {
  onMessage({ event, timestamp: new Date(), ...details });
}

// ── tool name/args extraction ──

function extractToolName(params: Record<string, unknown>): string | null {
  const raw = params['tool'] ?? params['name'] ?? null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractToolArguments(params: Record<string, unknown>): Record<string, unknown> {
  const raw = params['arguments'];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

// ── auto-answer helpers for tool requestUserInput ──

function tryAutoApproveAnswers(params: Record<string, unknown>): Record<string, unknown> | null {
  const questions = params['questions'];
  if (!Array.isArray(questions)) return null;

  const answers: Record<string, unknown> = {};
  for (const q of questions) {
    if (typeof q !== 'object' || q === null) return null;
    const questionId = (q as Record<string, unknown>)['id'];
    if (typeof questionId !== 'string') return null;

    const options = (q as Record<string, unknown>)['options'];
    if (!Array.isArray(options)) return null;

    const label = findApprovalLabel(options);
    if (label == null) return null;
    answers[questionId] = { answers: [label] };
  }

  return Object.keys(answers).length > 0 ? answers : null;
}

function findApprovalLabel(options: unknown[]): string | null {
  const labels = options
    .map((o) => typeof o === 'object' && o !== null ? (o as Record<string, unknown>)['label'] : null)
    .filter((l): l is string => typeof l === 'string');

  return labels.find((l) => l === 'Approve this Session')
    ?? labels.find((l) => l === 'Approve Once')
    ?? labels.find((l) => approvalOptionLabel(l))
    ?? null;
}

function approvalOptionLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized.startsWith('approve') || normalized.startsWith('allow');
}

function tryNonInteractiveAnswers(params: Record<string, unknown>): Record<string, unknown> | null {
  const questions = params['questions'];
  if (!Array.isArray(questions)) return null;

  const answers: Record<string, unknown> = {};
  for (const q of questions) {
    if (typeof q !== 'object' || q === null) return null;
    const questionId = (q as Record<string, unknown>)['id'];
    if (typeof questionId !== 'string') return null;
    answers[questionId] = { answers: [NON_INTERACTIVE_ANSWER] };
  }

  return Object.keys(answers).length > 0 ? answers : null;
}

// ── needs_input ──

const INPUT_REQUIRED_METHODS = new Set([
  'turn/input_required',
  'turn/needs_input',
  'turn/need_input',
  'turn/request_input',
  'turn/request_response',
  'turn/provide_input',
  'turn/approval_required',
]);

function needsInput(method: string, payload: Record<string, unknown>): boolean {
  if (method === METHODS.MCP_ELICITATION) return true;
  if (method.startsWith('turn/') && INPUT_REQUIRED_METHODS.has(method)) return true;
  if (payloadRequiresInput(payload)) return true;
  const params = payload['params'];
  if (params != null && typeof params === 'object' && !Array.isArray(params)) {
    return payloadRequiresInput(params as Record<string, unknown>);
  }
  return false;
}

function payloadRequiresInput(p: Record<string, unknown>): boolean {
  return p['requiresInput'] === true
    || p['needsInput'] === true
    || p['input_required'] === true
    || p['inputRequired'] === true
    || p['type'] === 'input_required'
    || p['type'] === 'needs_input';
}

// ── stream log helper ──

function logStreamLine(data: string, label: string): void {
  const text = data.trim().slice(0, 1000);
  if (text.length === 0) return;
  if (/\b(error|warn|warning|failed|fatal|panic|exception)\b/i.test(text)) {
    logger.warn(`Codex ${label} output: ${text}`);
  } else {
    logger.debug(`Codex ${label} output: ${text}`);
  }
}
