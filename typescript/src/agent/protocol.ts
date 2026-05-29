// ── JSON-RPC 2.0 types ──

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Method names (Codex app-server protocol) ──

export const METHODS = {
  INITIALIZE: 'initialize',
  INITIALIZED: 'initialized',
  THREAD_START: 'thread/start',
  TURN_START: 'turn/start',
  TURN_COMPLETED: 'turn/completed',
  TURN_FAILED: 'turn/failed',
  TURN_CANCELLED: 'turn/cancelled',
  COMMAND_EXECUTION_APPROVAL: 'item/commandExecution/requestApproval',
  FILE_CHANGE_APPROVAL: 'item/fileChange/requestApproval',
  EXEC_COMMAND_APPROVAL: 'execCommandApproval',
  APPLY_PATCH_APPROVAL: 'applyPatchApproval',
  TOOL_CALL: 'item/tool/call',
  TOOL_REQUEST_USER_INPUT: 'item/tool/requestUserInput',
  MCP_ELICITATION: 'mcpServer/elicitation/request',
  THREAD_TOKEN_USAGE: 'thread/tokenUsage/updated',
} as const;

// ── Event types emitted to orchestrator (Spec 10.4) ──

export type CodexEventType =
  | 'session_started'
  | 'startup_failed'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_cancelled'
  | 'turn_ended_with_error'
  | 'turn_input_required'
  | 'approval_auto_approved'
  | 'unsupported_tool_call'
  | 'notification'
  | 'other_message'
  | 'malformed';
