// Prompt builder — Spec Section 8

import { Liquid } from 'liquidjs';
import type { Issue, Result } from '../types.js';
import { TypedError } from '../types.js';

const DEFAULT_PROMPT = 'You are working on an issue from Linear.';

export function buildPrompt(issue: Issue, attempt: number | null, template: string): Result<string> {
  if (!template || template.trim() === '') {
    return { ok: true, value: DEFAULT_PROMPT };
  }

  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
  });

  let parsed;
  try {
    parsed = engine.parse(template);
  } catch (err: unknown) {
    return {
      ok: false,
      error: new TypedError('template_parse_error', `Template parse error: ${(err as Error).message}`, err),
    };
  }

  try {
    const ctx = {
      issue: toLiquidMap(issue),
      attempt,
    };
    const result = engine.renderSync(parsed, ctx);
    return { ok: true, value: result };
  } catch (err: unknown) {
    return {
      ok: false,
      error: new TypedError('template_render_error', `Template render error: ${(err as Error).message}`, err),
    };
  }
}

function toLiquidMap(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(toLiquidMap);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = toLiquidMap(value);
    }
    return result;
  }
  return obj;
}
