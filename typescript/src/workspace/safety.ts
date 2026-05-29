// Path safety — symlink-aware canonicalization and workspace path validation

import { lstatSync, readlinkSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { Result } from '../types.js';
import { TypedError } from '../types.js';

const SANITIZE_RE = /[^A-Za-z0-9._-]/g;
const ENV_REF_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function sanitizeKey(identifier: string): string {
  return (identifier || 'issue').replace(SANITIZE_RE, '_');
}

export function resolveEnvRef(value: string): string | null | undefined {
  const match = ENV_REF_RE.exec(value);
  if (!match) return undefined;
  const envVal = process.env[match[1]];
  if (envVal === '') return null;
  return envVal;
}

export function canonicalize(filePath: string): Result<string> {
  const expanded = resolve(filePath);
  const segments = expanded.split(sep);
  const root = segments[0] || sep;

  const result = resolveSegments(root, [], segments.slice(1));
  if (!result.ok) return result;
  return { ok: true, value: result.value };
}

function resolveSegments(root: string, resolved: string[], remaining: string[]): Result<string> {
  if (remaining.length === 0) {
    return { ok: true, value: joinPath(root, resolved) };
  }

  const [segment, ...rest] = remaining;
  const candidatePath = joinPath(root, [...resolved, segment]);

  let stat;
  try {
    stat = lstatSync(candidatePath);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException | undefined;
    if (nodeErr?.code === 'ENOENT') {
      return { ok: true, value: joinPath(root, [...resolved, segment, ...rest]) };
    }
    return {
      ok: false,
      error: new TypedError('workspace_path_escape', `Cannot stat path: ${candidatePath}`, err),
    };
  }

  if (stat.isSymbolicLink()) {
    try {
      const target = readlinkSync(candidatePath);
      const resolvedTarget = resolve(joinPath(root, resolved), target);
      const targetSegments = resolvedTarget.split(sep);
      const targetRoot = targetSegments[0] || sep;
      return resolveSegments(targetRoot, [], [...targetSegments.slice(1), ...rest]);
    } catch (err: unknown) {
      return {
        ok: false,
        error: new TypedError('workspace_path_escape', `Cannot read symlink: ${candidatePath}`, err),
      };
    }
  }

  return resolveSegments(root, [...resolved, segment], rest);
}

function joinPath(root: string, segments: string[]): string {
  return segments.length === 0 ? root : join(root, ...segments);
}

export function validateWorkspacePath(workspacePath: string, root: string): Result<void> {
  const canonicalWorkspace = canonicalize(workspacePath);
  if (!canonicalWorkspace.ok) return { ok: false, error: canonicalWorkspace.error };

  const canonicalRoot = canonicalize(root);
  if (!canonicalRoot.ok) return { ok: false, error: canonicalRoot.error };

  const cw = canonicalWorkspace.value;
  const cr = canonicalRoot.value;

  if (cw === cr) {
    return {
      ok: false,
      error: new TypedError('workspace_path_escape', `Workspace path equals root: ${cw}`),
    };
  }

  const prefix = cr + sep;
  if (cw.startsWith(prefix)) {
    return { ok: true, value: undefined };
  }

  const expandedWorkspace = resolve(workspacePath);
  const expandedRoot = resolve(root);
  if (expandedWorkspace.startsWith(expandedRoot + sep)) {
    return {
      ok: false,
      error: new TypedError('workspace_path_escape', `Symlink escape detected: ${expandedWorkspace} resolves outside ${cr}`),
    };
  }

  return {
    ok: false,
    error: new TypedError('workspace_path_escape', `Workspace path outside root: ${cw} not under ${cr}`),
  };
}
