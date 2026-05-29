// SSH worker extension — Spec Appendix A

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../observability/logger.js';

export interface ParsedHost {
  host: string;
  port: number | null;
  user: string | null;
}

export function parseSshHost(hostStr: string): ParsedHost {
  let user: string | null = null;
  let host = hostStr;
  let port: number | null = null;

  // Extract user
  const atIdx = host.indexOf('@');
  if (atIdx > 0) {
    user = host.substring(0, atIdx);
    host = host.substring(atIdx + 1);
  }

  // Extract port (host:port or [ipv6]:port)
  const bracketMatch = host.match(/^\[(.+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    port = bracketMatch[2] ? parseInt(bracketMatch[2], 10) : null;
  } else {
    const colonIdx = host.lastIndexOf(':');
    if (colonIdx > 0) {
      const maybePort = host.substring(colonIdx + 1);
      if (/^\d+$/.test(maybePort)) {
        port = parseInt(maybePort, 10);
        host = host.substring(0, colonIdx);
      }
    }
  }

  return { host, port, user };
}

export function buildSshArgs(
  target: ParsedHost,
  command: string,
  sshConfig?: string,
): string[] {
  const args: string[] = [];

  if (sshConfig) {
    args.push('-F', sshConfig);
  }

  if (target.port) {
    args.push('-p', String(target.port));
  }

  const dest = target.user ? `${target.user}@${target.host}` : target.host;
  args.push(dest, command);

  return args;
}

export function execOverSsh(
  command: string,
  target: ParsedHost,
  cwd: string,
  timeoutMs: number,
  sshConfig?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = buildSshArgs(target, command, sshConfig);
    const proc = spawn('ssh', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });

    let settled = false;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const killGroup = (signal: number | NodeJS.Signals) => {
      if (proc.pid == null) return;
      try { process.kill(-proc.pid, signal); } catch { /* group already gone */ }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup('SIGTERM');
      const grace = setTimeout(() => killGroup('SIGKILL'), 2000);
      grace.unref();
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      killGroup('SIGKILL'); // cleanup lingering children
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: err.message });
    });
  });
}

export function spawnRemoteCodex(
  target: ParsedHost,
  codexCommand: string,
  workspace: string,
  sshConfig?: string,
): ChildProcess {
  const command = `cd ${JSON.stringify(workspace)} && bash -lc ${JSON.stringify(codexCommand)}`;
  const args = buildSshArgs(target, command, sshConfig);

  logger.info('Spawning remote Codex via SSH', {
    host: target.host,
    port: target.port,
    user: target.user,
  });

  return spawn('ssh', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
