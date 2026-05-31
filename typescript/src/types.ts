// Symphony domain types — Spec Section 4

// ── Result type ──

export type Result<T, E = TypedError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ── Error kinds (Spec Section 5.5, 11.4, 10.6, 14.1) ──

export type ErrorKind =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error'
  | 'invalid_workflow_config'
  | 'workspace_creation_error'
  | 'workspace_path_escape'
  | 'hook_failed'
  | 'hook_timeout'
  | 'codex_not_found'
  | 'invalid_workspace_cwd'
  | 'response_timeout'
  | 'turn_timeout'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_input_required'
  | 'port_exit'
  | 'response_error'
  | 'stall_timeout'
  | 'spawn_failed'
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor'
  | 'unknown';

export class TypedError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TypedError';
  }
}

// ── Issue (Spec 4.1.1) ──

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
  assignee_id: string | null;
}

// ── Workflow (Spec 4.1.2) ──

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

// ── Config types (Spec 5.3) ──

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  kind: 'codex';
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: string | null;
  threadSandbox: string | null;
  turnSandboxPolicy: string | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface WorkerConfig {
  sshHosts: string[];
  maxConcurrentAgentsPerHost: number | null;
}

export interface ServerConfig {
  port: number | null;
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  worker: WorkerConfig;
  server: ServerConfig;
}

// ── Workspace (Spec 4.1.4) ──

export interface WorkspaceInfo {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

// ── Run Attempt phases (Spec 4.1.5 / 7.2) ──

export type RunAttemptPhase =
  | 'preparing_workspace'
  | 'building_prompt'
  | 'launching_agent_process'
  | 'initializing_session'
  | 'streaming_turn'
  | 'finishing'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'stalled'
  | 'cancelled_by_reconciliation';

// ── Live Session (Spec 4.1.6) ──

export interface LiveSession {
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  codexAppServerPid: string | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: Date | null;
  lastCodexMessage: string;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
}

// ── Retry Entry (Spec 4.1.7) ──

export interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  timerHandle: NodeJS.Timeout;
  retryToken: symbol;
  error: string | null;
  workerHost: string | null;
  workspacePath: string | null;
}

// ── Running Entry (Spec 4.1.6 + 4.1.7 combined) ──

export interface RunningEntry extends LiveSession {
  issueId: string;
  identifier: string;
  issue: Issue;
  retryAttempt: number;
  startedAt: Date;
  workerHost: string | null;
  workspacePath: string | null;
  abortController: AbortController;
}

// ── Codex Totals ──

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  secondsRunning: number;
}

// ── Orchestrator State (Spec 4.1.8) ──

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codexTotals: CodexTotals;
  codexRateLimits: Record<string, unknown> | null;
}

// ── Codex Update Event (Spec 10.4) ──

export interface CodexUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface CodexUpdateEvent {
  event: string;
  timestamp: Date;
  codexAppServerPid?: string;
  usage?: CodexUsage;
  message?: string;
  payload?: Record<string, unknown>;
}

// ── Snapshot types (Spec 13.3, 13.7.2) ──

export interface RunningSessionRow {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string;
  started_at: string;
  last_event_at: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
  worker_host: string | null;
}

export interface RetryQueueRow {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningSessionRow[];
  retrying: RetryQueueRow[];
  codex_totals: CodexTotals & { seconds_running: number };
  rate_limits: Record<string, unknown> | null;
}

// ── Worker exit reason ──

export type WorkerExitReason = 'normal' | 'abnormal';
