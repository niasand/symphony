import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitizeKey, canonicalize, validateWorkspacePath } from '../src/workspace/safety.js';
import { createForIssue, removeWorkspace } from '../src/workspace/manager.js';
import { createTempDir, cleanupTempDir, defaultConfig } from './helpers.js';

describe('workspace/safety — sanitizeKey', () => {
  it('replaces non-alphanumeric chars with _', () => {
    expect(sanitizeKey('SYM 42/beta')).toBe('SYM_42_beta');
  });

  it('keeps [A-Za-z0-9._-]', () => {
    const key = sanitizeKey('ABC.123_def-456');
    expect(key).toBe('ABC.123_def-456');
  });

  it('handles empty string', () => {
    expect(sanitizeKey('')).toBe('issue');
  });

  it('handles special characters', () => {
    expect(sanitizeKey('hello@world!#')).toBe('hello_world__');
  });
});

describe('workspace/safety — canonicalize', () => {
  it('resolves normal paths', () => {
    const result = canonicalize('/tmp/some/path');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // macOS resolves /tmp to /private/tmp
    expect(result.value).toMatch(/\/tmp\/some\/path$/);
  });

  it('handles non-existent paths (no symlink issues)', () => {
    const result = canonicalize('/tmp/definitely_nonexistent_path_xyz');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain('definitely_nonexistent_path_xyz');
  });
});

describe('workspace/safety — validateWorkspacePath', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpRoot);
  });

  it('accepts paths inside root', () => {
    const childPath = join(tmpRoot, 'workspace-1');
    mkdirSync(childPath);

    const result = validateWorkspacePath(childPath, tmpRoot);
    expect(result.ok).toBe(true);
  });

  it('rejects paths outside root', () => {
    const result = validateWorkspacePath('/etc/passwd', tmpRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('workspace_path_escape');
  });

  it('rejects workspace path equal to root', () => {
    const result = validateWorkspacePath(tmpRoot, tmpRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('workspace_path_escape');
  });

  it('detects symlink escapes (symlink inside root pointing outside)', () => {
    const outsideDir = createTempDir();
    const outsideTarget = join(outsideDir, 'outside-file');
    writeFileSync(outsideTarget, 'data');

    const linkPath = join(tmpRoot, 'escaped-link');
    symlinkSync(outsideTarget, linkPath);

    const result = validateWorkspacePath(linkPath, tmpRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('workspace_path_escape');

    cleanupTempDir(outsideDir);
  });
});

describe('workspace/manager — createForIssue', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpRoot);
  });

  it('creates new workspace directory', async () => {
    const config = defaultConfig({ workspace: { root: tmpRoot } });
    const result = await createForIssue('SYM-42', config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(result.value.path)).toBe(true);
    expect(statSync(result.value.path).isDirectory()).toBe(true);
  });

  it('reuses existing workspace', async () => {
    const config = defaultConfig({ workspace: { root: tmpRoot } });

    // First creation
    const result1 = await createForIssue('SYM-42', config);
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect(result1.value.createdNow).toBe(true);

    // Second creation (reuse)
    const result2 = await createForIssue('SYM-42', config);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.createdNow).toBe(false);
    expect(result2.value.path).toBe(result1.value.path);
  });

  it('sets createdNow=true on first creation', async () => {
    const config = defaultConfig({ workspace: { root: tmpRoot } });
    const result = await createForIssue('SYM-99', config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdNow).toBe(true);
    expect(result.value.workspaceKey).toBe('SYM-99');
  });

  it('replaces file with directory if workspace path is a file', async () => {
    const config = defaultConfig({ workspace: { root: tmpRoot } });
    // Create a file where the workspace directory would be
    const key = sanitizeKey('SYM-42');
    const filePath = join(tmpRoot, key);
    writeFileSync(filePath, 'not a directory');

    const result = await createForIssue('SYM-42', config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdNow).toBe(true);
    expect(statSync(result.value.path).isDirectory()).toBe(true);
  });
});

describe('workspace/manager — removeWorkspace', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpRoot);
  });

  it('removes directory', async () => {
    const config = defaultConfig({ workspace: { root: tmpRoot } });
    const createResult = await createForIssue('DEL-1', config);
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    expect(existsSync(createResult.value.path)).toBe(true);

    await removeWorkspace(createResult.value.path, config);
    expect(existsSync(createResult.value.path)).toBe(false);
  });

  it('does not throw when removing non-existent directory', async () => {
    const config = defaultConfig({ workspace: { root: tmpRoot } });
    // Should not throw
    await removeWorkspace(join(tmpRoot, 'nonexistent'), config);
  });
});
