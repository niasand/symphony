// Workflow loader — Spec Section 4.1.2

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Result, WorkflowDefinition } from '../types.js';
import { TypedError } from '../types.js';

export function load(path: string): Result<WorkflowDefinition> {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException | undefined;
    if (nodeErr?.code === 'ENOENT') {
      return { ok: false, error: new TypedError('missing_workflow_file', `Workflow file not found: ${path}`, err) };
    }
    return { ok: false, error: new TypedError('missing_workflow_file', `Failed to read workflow file: ${path}`, err) };
  }

  return parse(content);
}

function parse(content: string): Result<WorkflowDefinition> {
  const { frontMatterLines, promptLines } = splitFrontMatter(content);

  const configResult = parseFrontMatter(frontMatterLines);
  if (!configResult.ok) return configResult;

  const promptTemplate = promptLines.join('\n').trim();

  return {
    ok: true,
    value: { config: configResult.value, prompt_template: promptTemplate },
  };
}

function splitFrontMatter(content: string): { frontMatterLines: string[]; promptLines: string[] } {
  const lines = content.split(/\r?\n/);

  if (lines[0] === '---') {
    const closingIdx = lines.indexOf('---', 1);
    if (closingIdx !== -1) {
      return {
        frontMatterLines: lines.slice(1, closingIdx),
        promptLines: lines.slice(closingIdx + 1),
      };
    }
    return { frontMatterLines: lines.slice(1), promptLines: [] };
  }

  return { frontMatterLines: [], promptLines: lines };
}

function parseFrontMatter(lines: string[]): Result<Record<string, unknown>> {
  const yaml = lines.join('\n');

  if (yaml.trim() === '') {
    return { ok: true, value: {} };
  }

  try {
    const decoded = parseYaml(yaml);
    if (decoded === null || decoded === undefined) {
      return { ok: true, value: {} };
    }
    if (typeof decoded !== 'object' || Array.isArray(decoded)) {
      return {
        ok: false,
        error: new TypedError('workflow_front_matter_not_a_map', 'Workflow front matter must be a YAML mapping, not an array or primitive'),
      };
    }
    return { ok: true, value: decoded as Record<string, unknown> };
  } catch (err: unknown) {
    return {
      ok: false,
      error: new TypedError('workflow_parse_error', `YAML parse error: ${(err as Error).message}`, err),
    };
  }
}
