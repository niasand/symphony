// Workspace hook execution

import { spawn } from 'node:child_process';
import type { Result } from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';

const MAX_OUTPUT_LEN = 2048;

export function runHook(script: string, workspacePath: string, hookName: string, timeoutMs: number): Promise<Result<void>> {
  logger.info(`Running hook hook=${hookName} workspace=${workspacePath}`);

  return new Promise<Result<void>>((resolve) => {
    const child = spawn('bash', ['-lc', script], {
      cwd: workspacePath,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
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

    child.on('error', (err) => {
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
