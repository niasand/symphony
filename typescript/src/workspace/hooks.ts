// Workspace hook execution — process-group-level cleanup

import { spawn } from 'node:child_process';
import type { Result } from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';

const MAX_OUTPUT_LEN = 2048;
const GRACE_PERIOD_MS = 2000;

export function runHook(script: string, workspacePath: string, hookName: string, timeoutMs: number): Promise<Result<void>> {
  logger.info(`Running hook hook=${hookName} workspace=${workspacePath}`);

  return new Promise<Result<void>>((resolve) => {
    const proc = spawn('bash', ['-lc', script], {
      cwd: workspacePath,
      detached: true, // new process group — allows group-level signal on timeout/exec
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Kill the entire process group (negative PID). Swallow errors if group
    // already exited — this is best-effort cleanup.
    const killGroup = (signal: number | NodeJS.Signals) => {
      if (proc.pid == null) return;
      try {
        process.kill(-proc.pid, signal);
      } catch {
        // process group already gone — nothing to do
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      logger.warn(`Hook timed out hook=${hookName} timeout=${timeoutMs}ms — sending SIGTERM to process group`);
      killGroup('SIGTERM');

      // Grace period then force-kill
      const graceTimer = setTimeout(() => {
        killGroup('SIGKILL');
      }, GRACE_PERIOD_MS);
      graceTimer.unref();

      resolve({
        ok: false,
        error: new TypedError('hook_timeout', `Hook '${hookName}' timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      // Kill process group to clean up any lingering children
      killGroup('SIGKILL');

      if (code !== 0) {
        const output = truncateOutput(stdout + stderr);
        logger.warn(`Hook failed hook=${hookName} code=${code} output=${output}`);
        resolve({
          ok: false,
          error: new TypedError('hook_failed', `Hook '${hookName}' exited with code ${code}: ${output}`),
        });
        return;
      }
      resolve({ ok: true, value: undefined });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        error: new TypedError('hook_failed', `Hook '${hookName}' spawn error: ${err.message}`, err),
      });
    });
  });
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LEN) return output;
  return output.slice(0, MAX_OUTPUT_LEN) + '... (truncated)';
}
