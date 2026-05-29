import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('timeout returns hook_failed (spawn error)', async () => {
    // Use a script that sleeps longer than the timeout
    const result = await runHook('sleep 10', tmpDir, 'timeout_hook', 200);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The spawn with timeout sends SIGTERM which results in a non-zero exit
    expect(result.error.kind).toBe('hook_failed');
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
});
