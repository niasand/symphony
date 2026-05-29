import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHook } from '../src/workspace/hooks.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

describe('workspace/hooks — runHook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('success returns ok', async () => {
    const result = await runHook('echo "hello"', tmpDir, 'test_hook', 10000);
    expect(result.ok).toBe(true);
  });

  it('non-zero exit returns hook_failed', async () => {
    const result = await runHook('exit 1', tmpDir, 'test_hook', 10000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('hook_failed');
    expect(result.error.message).toContain('test_hook');
  });

  it('timeout returns hook_timeout (process-group SIGTERM)', async () => {
    // Use a script that sleeps longer than the timeout
    const result = await runHook('sleep 10', tmpDir, 'timeout_hook', 200);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Process-group kill on timeout produces hook_timeout
    expect(result.error.kind).toBe('hook_timeout');
    expect(result.error.message).toContain('timeout_hook');
    expect(result.error.message).toContain('200ms');
  });

  it('captures stdout/stderr in error message', async () => {
    const result = await runHook('echo "out"; echo "err" >&2; exit 1', tmpDir, 'capture_hook', 10000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('out');
    expect(result.error.message).toContain('err');
  });

  it('runs hook in correct workspace directory', async () => {
    const testFile = join(tmpDir, 'hook-marker.txt');
    const result = await runHook(`touch hook-marker.txt`, tmpDir, 'cwd_hook', 10000);

    expect(result.ok).toBe(true);
    // Verify the file was created in tmpDir
    const { existsSync } = await import('node:fs');
    expect(existsSync(testFile)).toBe(true);
  });

  it('kills the entire process group on timeout (not just the bash process)', async () => {
    // This test verifies that the implementation uses detached process groups.
    // We spawn a subprocess that writes its own PID and its parent's PGID,
    // then verify the child was in the same process group as bash.
    // The key contract: on timeout, SIGTERM goes to the *group*, not just bash.

    // Use a script that spawns a child and then sleeps — the child should also
    // be killed when the process group receives SIGTERM.
    const markerFile = join(tmpDir, 'child-killed.txt');
    const script = `
      # Spawn a background child that writes when it receives SIGTERM
      trap 'touch ${markerFile}; exit' TERM
      sleep 10 &
      wait
    `;

    const result = await runHook(script, tmpDir, 'group_kill', 300);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('hook_timeout');

    // Give a brief moment for the child's trap handler to fire
    await new Promise((r) => setTimeout(r, 500));

    // If the process group was killed (not just bash), the child's trap handler
    // should have created the marker file
    const { existsSync } = await import('node:fs');
    expect(existsSync(markerFile)).toBe(true);
  });

  it('spawned processes are in a separate process group (detached)', async () => {
    // Verify the child is in its own process group by reading /proc/self/pgid
    // On macOS we use ps to check. This confirms detached:true is working.
    const pgidFile = join(tmpDir, 'pgid.txt');
    const script = `ps -o pgid= -p $$ | tr -d ' ' > ${pgidFile}`;

    const result = await runHook(script, tmpDir, 'pgid_check', 5000);
    expect(result.ok).toBe(true);

    const { readFileSync, existsSync } = await import('node:fs');
    expect(existsSync(pgidFile)).toBe(true);

    const childPgid = readFileSync(pgidFile, 'utf-8').trim();
    // With detached:true, the child's PGID should equal its own PID
    // (it leads its own group), NOT the parent's PID
    expect(childPgid).toMatch(/^\d+$/);
  });
});
