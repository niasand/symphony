import type { ServiceConfig } from '../../types.js';

// ── Tool spec (advertised to app-server) ──

export const LINEAR_GRAPHQL_TOOL_SPEC = {
  name: 'linear_graphql',
  description: 'Execute a GraphQL query or mutation against the Linear API using the configured tracker credentials.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'A single GraphQL query or mutation document' },
      variables: { type: 'object', description: 'Optional GraphQL variables object' },
    },
    required: ['query'],
  },
};

// ── Input type after normalization ──

interface LinearGraphqlInput {
  query: string;
  variables?: Record<string, unknown>;
}

// ── Validation ──

function validateInput(input: unknown): { ok: true; value: LinearGraphqlInput } | { ok: false; error: string } {
  // Shorthand: raw string → treat as query with no variables
  if (typeof input === 'string') {
    if (input.trim().length === 0) {
      return { ok: false, error: 'invalid input: query must be a non-empty string' };
    }
    if (countOperations(input) !== 1) {
      return { ok: false, error: 'invalid input: query must contain exactly one GraphQL operation' };
    }
    return { ok: true, value: { query: input } };
  }

  // Structured object
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'invalid input: expected a string or an object with "query" field' };
  }

  const obj = input as Record<string, unknown>;

  const query = obj['query'];
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { ok: false, error: 'invalid input: query must be a non-empty string' };
  }

  if (countOperations(query) !== 1) {
    return { ok: false, error: 'invalid input: query must contain exactly one GraphQL operation' };
  }

  const variables = obj['variables'];
  if (variables !== undefined) {
    if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) {
      return { ok: false, error: 'invalid input: variables must be a plain object' };
    }
  }

  return {
    ok: true,
    value: {
      query,
      ...(variables !== undefined ? { variables: variables as Record<string, unknown> } : {}),
    },
  };
}

/**
 * Count the number of named GraphQL operations (query/mutation/subscription)
 * in a document. Anonymous queries count as 1. Returns 0 for fragments-only.
 */
function countOperations(doc: string): number {
  const operationPattern = /\b(query|mutation|subscription)\s*\{/g;
  const namedPattern = /\b(query|mutation|subscription)\s+\w+/g;

  // Count anonymous operations like `query { ... }` or `{ ... }`
  let count = 0;
  const matches = doc.match(operationPattern);
  if (matches) count += matches.length;

  // Count named operations like `query Foo { ... }`
  // Named operations already have a `{` after the keyword that matched above,
  // so we subtract the overlap and add the named count.
  const namedMatches = doc.match(namedPattern);
  if (namedMatches) {
    // Named operations were already counted once by operationPattern (which matches `query {`),
    // but named ops have a name between keyword and `{`. We need a cleaner approach.
  }

  // Cleaner approach: find all operation keywords
  const opKeywordPattern = /\b(query|mutation|subscription)\b/g;
  const allKeywords = doc.match(opKeywordPattern);
  if (!allKeywords) {
    // No explicit keyword — check for shorthand (bare `{ ... }`)
    const trimmed = doc.trim();
    if (trimmed.startsWith('{')) return 1;
    return 0;
  }

  return allKeywords.length;
}

// ── Execution ──

export async function executeLinearGraphql(
  input: unknown,
  config: ServiceConfig,
): Promise<{ success: boolean; output: unknown }> {
  // Validate input
  const validated = validateInput(input);
  if (!validated.ok) {
    return { success: false, output: { error: validated.error } };
  }

  const { query, variables } = validated.value;

  // Check auth
  if (!config.tracker.apiKey) {
    return { success: false, output: { error: 'missing Linear auth' } };
  }

  // Execute
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch(config.tracker.endpoint, {
      method: 'POST',
      headers: {
        Authorization: config.tracker.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, output: { error: `transport error: Linear API returned status ${response.status}` } };
    }

    const body = (await response.json()) as Record<string, unknown>;

    // Check for GraphQL-level errors
    if (Array.isArray(body['errors'])) {
      return { success: false, output: { errors: body['errors'], data: body['data'] ?? null } };
    }

    return { success: true, output: body['data'] ?? {} };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown transport error';
    return { success: false, output: { error: `transport error: ${message}` } };
  }
}
