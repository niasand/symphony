// Workspace lifecycle management — Spec Section 6

import { mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Result, ServiceConfig, WorkspaceInfo } from '../types.js';
import { TypedError } from '../types.js';
import { sanitizeKey, canonicalize, validateWorkspacePath } from './safety.js';
import { runHook } from './hooks.js';
import { logger } from '../observability/logger.js';

export async function createForIssue(identifier: string, config: ServiceConfig): Promise<Result<WorkspaceInfo>> {
  const workspaceKey = sanitizeKey(identifier);
  const rawPath = join(config.workspace.root, workspaceKey);

  const canonResult = canonicalize(rawPath);
  if (!canonResult.ok) {
    return { ok: false, error: new TypedError('workspace_creation_error', `Cannot canonicalize workspace path: ${rawPath}`, canonResult.error) };
  }
  const workspacePath = canonResult.value;

  const validation = validateWorkspacePath(workspacePath, config.workspace.root);
  if (!validation.ok) {
    return { ok: false, error: new TypedError('workspace_creation_error', `Invalid workspace path: ${workspacePath}`, validation.error) };
  }

  let createdNow = false;

  try {
    if (existsSync(workspacePath)) {
      const stat = statSync(workspacePath);
      if (!stat.isDirectory()) {
        rmSync(workspacePath, { recursive: true, force: true });
        mkdirSync(workspacePath, { recursive: true });
        createdNow = true;
      }
    } else {
      mkdirSync(workspacePath, { recursive: true });
      createdNow = true;
    }
  } catch (err: unknown) {
    return {
      ok: false,
      error: new TypedError('workspace_creation_error', `Failed to create workspace: ${workspacePath}`, err),
    };
  }

  if (createdNow && config.hooks.afterCreate) {
    const hookResult = await runHook(config.hooks.afterCreate, workspacePath, 'after_create', config.hooks.timeoutMs);
    if (!hookResult.ok) {
      try {
        rmSync(workspacePath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      return {
        ok: false,
        error: new TypedError('workspace_creation_error', `after_create hook failed, workspace removed: ${workspacePath}`, hookResult.error),
      };
    }
  }

  logger.info(`Workspace ready workspace=${workspacePath} created=${createdNow}`);
  return { ok: true, value: { path: workspacePath, workspaceKey, createdNow } };
}

export async function removeWorkspace(workspacePath: string, config: ServiceConfig): Promise<void> {
  if (config.hooks.beforeRemove) {
    const hookResult = await runHook(config.hooks.beforeRemove, workspacePath, 'before_remove', config.hooks.timeoutMs);
    if (!hookResult.ok) {
      logger.warn(`before_remove hook failed, continuing with removal workspace=${workspacePath}`, { error: String(hookResult.error) });
    }
  }

  try {
    rmSync(workspacePath, { recursive: true, force: true });
    logger.info(`Workspace removed workspace=${workspacePath}`);
  } catch (err: unknown) {
    logger.error(`Failed to remove workspace workspace=${workspacePath}`, { error: String(err) });
  }
}
