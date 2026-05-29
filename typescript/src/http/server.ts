// Optional HTTP server — Spec Section 13.7

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { logger } from '../observability/logger.js';
import type { Orchestrator } from '../orchestrator/index.js';

export interface HttpServerOptions {
  port: number;
  host?: string;
}

export function startHttpServer(orchestrator: Orchestrator, options: HttpServerOptions): void {
  const host = options.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    handleRequest(req, res, orchestrator);
  });

  server.listen(options.port, host, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : options.port;
    logger.info('HTTP server started', { host, port });
  });

  server.on('error', (err) => {
    logger.error('HTTP server error', { error: err.message });
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, orchestrator: Orchestrator): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (path === '/' && req.method === 'GET') {
      handleDashboard(res, orchestrator);
    } else if (path === '/api/v1/state' && req.method === 'GET') {
      handleStateApi(res, orchestrator);
    } else if (path.startsWith('/api/v1/') && req.method === 'GET') {
      handleIssueApi(res, path, orchestrator);
    } else if (path === '/api/v1/refresh' && req.method === 'POST') {
      handleRefresh(res, orchestrator);
    } else if (path.startsWith('/api/')) {
      jsonResponse(res, 404, { error: { code: 'not_found', message: 'Endpoint not found' } });
    } else {
      jsonResponse(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    }
  } catch (err) {
    logger.error('HTTP request handler error', { error: String(err) });
    jsonResponse(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
  }
}

function handleDashboard(res: ServerResponse, orchestrator: Orchestrator): void {
  const snapshot = orchestrator.snapshot();
  const html = renderDashboardHtml(snapshot);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function handleStateApi(res: ServerResponse, orchestrator: Orchestrator): void {
  const snapshot = orchestrator.snapshot();
  jsonResponse(res, 200, snapshot);
}

function handleIssueApi(res: ServerResponse, path: string, orchestrator: Orchestrator): void {
  const identifier = path.replace('/api/v1/', '');
  if (!identifier) {
    jsonResponse(res, 400, { error: { code: 'bad_request', message: 'Issue identifier required' } });
    return;
  }

  const state = orchestrator.getState();
  const running = state.running.get(
    // Search by identifier in running entries
    [...state.running.entries()].find(([, e]) => e.identifier === identifier)?.[0] ?? identifier,
  );
  const retry = state.retryAttempts.get(
    [...state.retryAttempts.entries()].find(([, e]) => e.identifier === identifier)?.[0] ?? identifier,
  );

  if (!running && !retry) {
    jsonResponse(res, 404, { error: { code: 'issue_not_found', message: `Issue ${identifier} not found in current state` } });
    return;
  }

  const issueData: Record<string, unknown> = {
    issue_identifier: identifier,
    issue_id: running?.issueId ?? retry?.issueId ?? null,
    status: running ? 'running' : 'retrying',
  };

  if (running) {
    issueData.running = {
      session_id: running.sessionId,
      turn_count: running.turnCount,
      state: running.issue.state,
      started_at: running.startedAt.toISOString(),
      last_event: running.lastCodexEvent,
      last_message: running.lastCodexMessage,
      last_event_at: running.lastCodexTimestamp?.toISOString() ?? null,
      tokens: {
        input_tokens: running.codexInputTokens,
        output_tokens: running.codexOutputTokens,
        total_tokens: running.codexTotalTokens,
      },
    };
  }

  if (retry) {
    issueData.retry = {
      attempt: retry.attempt,
      due_at: new Date(retry.dueAtMs).toISOString(),
      error: retry.error,
    };
  }

  jsonResponse(res, 200, issueData);
}

function handleRefresh(res: ServerResponse, orchestrator: Orchestrator): void {
  const result = orchestrator.requestRefresh();
  jsonResponse(res, 202, result);
}

function jsonResponse(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function renderDashboardHtml(snapshot: ReturnType<Orchestrator['snapshot']>): string {
  const runningRows = snapshot.running.map((r) => `
    <tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${esc(r.state)}</td>
      <td>${esc(r.session_id ?? '-')}</td>
      <td>${r.turn_count}</td>
      <td>${esc(r.last_event ?? '-')}</td>
      <td>${esc(r.started_at)}</td>
      <td>${r.tokens.total_tokens.toLocaleString()}</td>
    </tr>`).join('');

  const retryRows = snapshot.retrying.map((r) => `
    <tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${r.attempt}</td>
      <td>${esc(r.due_at)}</td>
      <td>${esc(r.error ?? '-')}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; }
    h2 { color: #8b949e; margin-top: 2rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { padding: 0.5rem 1rem; border: 1px solid #30363d; text-align: left; }
    th { background: #161b22; color: #8b949e; }
    .stats { display: flex; gap: 2rem; margin: 1rem 0; }
    .stat { background: #161b22; padding: 1rem 1.5rem; border-radius: 6px; border: 1px solid #30363d; }
    .stat-value { font-size: 2rem; font-weight: bold; color: #58a6ff; }
    .stat-label { color: #8b949e; font-size: 0.875rem; }
    .actions { margin: 1rem 0; }
    button { background: #238636; color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
    button:hover { background: #2ea043; }
    footer { margin-top: 2rem; color: #484f58; font-size: 0.75rem; }
  </style>
</head>
<body>
  <h1>Symphony</h1>
  <div class="stats">
    <div class="stat"><div class="stat-value">${snapshot.counts.running}</div><div class="stat-label">Running</div></div>
    <div class="stat"><div class="stat-value">${snapshot.counts.retrying}</div><div class="stat-label">Retrying</div></div>
    <div class="stat"><div class="stat-value">${snapshot.codex_totals.totalTokens.toLocaleString()}</div><div class="stat-label">Total Tokens</div></div>
    <div class="stat"><div class="stat-value">${snapshot.codex_totals.seconds_running.toFixed(0)}s</div><div class="stat-label">Runtime</div></div>
  </div>

  <div class="actions">
    <button onclick="fetch('/api/v1/refresh',{method:'POST'}).then(()=>location.reload())">Refresh Now</button>
  </div>

  <h2>Running Sessions</h2>
  <table>
    <tr><th>Issue</th><th>State</th><th>Session</th><th>Turns</th><th>Last Event</th><th>Started</th><th>Tokens</th></tr>
    ${runningRows || '<tr><td colspan="7" style="text-align:center">No active sessions</td></tr>'}
  </table>

  <h2>Retry Queue</h2>
  <table>
    <tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr>
    ${retryRows || '<tr><td colspan="4" style="text-align:center">No pending retries</td></tr>'}
  </table>

  <footer>Generated at ${esc(snapshot.generated_at)}</footer>

  <script>setTimeout(()=>location.reload(), 5000)</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
