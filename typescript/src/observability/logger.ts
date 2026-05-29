// Structured JSON logger — Spec Section 13

export interface LogContext {
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
}

function formatLog(level: string, msg: string, ctx?: LogContext): string {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message: msg,
  };
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (v !== undefined) entry[k] = v;
    }
  }
  return JSON.stringify(entry);
}

function write(level: string, msg: string, ctx?: LogContext, stream: NodeJS.WritableStream = process.stderr): void {
  try {
    stream.write(formatLog(level, msg, ctx) + '\n');
  } catch {
    // Logging failures must not crash the orchestrator (Spec 13.2)
  }
}

export const logger: Logger = {
  info: (msg, ctx) => write('info', msg, ctx),
  warn: (msg, ctx) => write('warn', msg, ctx),
  error: (msg, ctx) => write('error', msg, ctx),
  debug: (msg, ctx) => write('debug', msg, ctx),
};
