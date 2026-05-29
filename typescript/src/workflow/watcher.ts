// Workflow file watcher — Spec Section 6.2

import { watch } from 'chokidar';
import { readFileSync } from 'node:fs';
import { parse as parseYaml, isMap } from 'yaml';
import type { Result, WorkflowDefinition } from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';

export type WorkflowChangeCallback = (workflow: WorkflowDefinition) => void;

export class WorkflowWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private lastGoodWorkflow: WorkflowDefinition | null = null;

  start(
    filePath: string,
    onChange: WorkflowChangeCallback,
    onError: (error: TypedError) => void,
  ): void {
    this.watcher = watch(filePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('change', () => {
      const result = loadWorkflow(filePath);
      if (result.ok) {
        this.lastGoodWorkflow = result.value;
        logger.info('Workflow file reloaded', { path: filePath });
        onChange(result.value);
      } else {
        logger.error('Invalid workflow reload; keeping last known good config', {
          path: filePath,
          error: result.error.message,
        });
        onError(result.error);
      }
    });

    this.watcher.on('error', (err) => {
      logger.error('Workflow watcher error', { path: filePath, error: String(err) });
    });

    logger.info('Watching workflow file', { path: filePath });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getLastGood(): WorkflowDefinition | null {
    return this.lastGoodWorkflow;
  }
}

export function loadWorkflow(path: string): Result<WorkflowDefinition> {
  try {
    const content = readFileSync(path, 'utf-8');
    const trimmed = content.trimStart();

    if (!trimmed.startsWith('---')) {
      return { ok: true, value: { config: {}, prompt_template: content.trim() } };
    }

    const lines = content.split('\n');
    let endFrontMatter = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        endFrontMatter = i;
        break;
      }
    }

    if (endFrontMatter === -1) {
      return {
        ok: false,
        error: new TypedError('workflow_parse_error', 'Unclosed YAML front matter'),
      };
    }

    const yamlStr = lines.slice(1, endFrontMatter).join('\n');
    const body = lines.slice(endFrontMatter + 1).join('\n').trim();

    let parsed: unknown;
    try {
      parsed = parseYaml(yamlStr);
    } catch (err) {
      return {
        ok: false,
        error: new TypedError('workflow_parse_error', `YAML parse error: ${err instanceof Error ? err.message : String(err)}`),
      };
    }

    if (parsed != null && typeof parsed === 'object' && !isMap(parsed) && !Array.isArray(parsed)) {
      // It's a plain object — good
    } else if (isMap(parsed)) {
      // yaml library returns YAMLMap for objects; convert to plain object
      parsed = parsed.toJSON();
    } else if (parsed === undefined || parsed === null) {
      parsed = {};
    } else if (Array.isArray(parsed)) {
      return {
        ok: false,
        error: new TypedError('workflow_front_matter_not_a_map', 'YAML front matter must decode to a map/object'),
      };
    } else {
      return {
        ok: false,
        error: new TypedError('workflow_front_matter_not_a_map', 'YAML front matter must decode to a map/object'),
      };
    }

    return {
      ok: true,
      value: { config: parsed as Record<string, unknown>, prompt_template: body },
    };
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        error: new TypedError('missing_workflow_file', `Workflow file not found: ${path}`),
      };
    }
    return {
      ok: false,
      error: new TypedError('workflow_parse_error', `Failed to read workflow: ${err instanceof Error ? err.message : String(err)}`),
    };
  }
}
