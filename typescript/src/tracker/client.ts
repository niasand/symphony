import type { Result, Issue, ServiceConfig } from '../types.js';
import { TypedError } from '../types.js';
import { logger } from '../observability/logger.js';
import { SYMPHONY_LINEAR_POLL, SYMPHONY_LINEAR_ISSUES_BY_ID } from './queries.js';
import { normalizeIssue } from './normalizer.js';

const PAGE_SIZE = 50;

// ── Public API ──

/**
 * Fetch all candidate issues in active states for the configured project.
 * Paginates through all pages automatically.
 */
export async function fetchCandidateIssues(config: ServiceConfig): Promise<Result<Issue[]>> {
  return paginateIssues(
    SYMPHONY_LINEAR_POLL,
    {
      projectSlug: config.tracker.projectSlug,
      stateNames: config.tracker.activeStates,
      first: PAGE_SIZE,
      relationFirst: PAGE_SIZE,
      after: null,
    },
    config,
    /* hasPageInfo */ true,
  );
}

/**
 * Fetch issues matching specific states. Returns empty array without API call
 * if states is empty.
 */
export async function fetchIssuesByStates(
  states: string[],
  config: ServiceConfig,
): Promise<Result<Issue[]>> {
  if (states.length === 0) return { ok: true, value: [] };

  return paginateIssues(
    SYMPHONY_LINEAR_POLL,
    {
      projectSlug: config.tracker.projectSlug,
      stateNames: states,
      first: PAGE_SIZE,
      relationFirst: PAGE_SIZE,
      after: null,
    },
    config,
    /* hasPageInfo */ true,
  );
}

/**
 * Fetch minimal issue data by IDs (for reconciliation).
 * Batches through pages of PAGE_SIZE.
 */
export async function fetchIssueStatesByIds(
  ids: string[],
  config: ServiceConfig,
): Promise<Result<Issue[]>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: true, value: [] };

  const allIssues: Issue[] = [];
  const orderIndex = new Map<string, number>();
  unique.forEach((id, idx) => orderIndex.set(id, idx));

  // Batch in chunks of PAGE_SIZE
  for (let i = 0; i < unique.length; i += PAGE_SIZE) {
    const batch = unique.slice(i, i + PAGE_SIZE);
    const gqlResult = await graphql(
      SYMPHONY_LINEAR_ISSUES_BY_ID,
      { ids: batch, first: batch.length, relationFirst: PAGE_SIZE },
      config,
    );

    if (!gqlResult.ok) return gqlResult;

    const nodes = extractNodes(gqlResult.value);
    if (nodes === null) {
      return {
        ok: false,
        error: new TypedError('linear_unknown_payload', 'Unexpected response shape from Linear'),
      };
    }

    for (const node of nodes) {
      const issue = normalizeIssue(node);
      if (issue) allIssues.push(issue);
    }
  }

  // Sort by original request order
  const fallback = unique.length;
  allIssues.sort((a, b) => {
    const ai = orderIndex.get(a.id) ?? fallback;
    const bi = orderIndex.get(b.id) ?? fallback;
    return ai - bi;
  });

  return { ok: true, value: allIssues };
}

// ── GraphQL transport ──

async function graphql(
  query: string,
  variables: Record<string, unknown>,
  config: ServiceConfig,
): Promise<Result<Record<string, unknown>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const apiKey = config.tracker.apiKey;
    if (!apiKey) {
      return {
        ok: false,
        error: new TypedError('missing_tracker_api_key', 'Missing Linear API key'),
      };
    }

    const response = await fetch(config.tracker.endpoint, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error('Linear GraphQL request failed', { status: response.status });
      return {
        ok: false,
        error: new TypedError(
          'linear_api_status',
          `Linear API returned status ${response.status}`,
        ),
      };
    }

    const body = (await response.json()) as Record<string, unknown>;

    if (Array.isArray(body['errors'])) {
      const errors = body['errors'];
      logger.error('Linear GraphQL errors', { errors });
      return {
        ok: false,
        error: new TypedError(
          'linear_graphql_errors',
          `Linear GraphQL returned ${errors.length} error(s)`,
          errors,
        ),
      };
    }

    return { ok: true, value: body };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return {
        ok: false,
        error: new TypedError('linear_api_request', 'Linear API request timed out (30s)'),
      };
    }
    logger.error('Linear GraphQL request failed', { error: String(err) });
    return {
      ok: false,
      error: new TypedError(
        'linear_api_request',
        err instanceof Error ? err.message : 'Linear API request failed',
        err,
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Pagination ──

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

async function paginateIssues(
  query: string,
  baseVars: Record<string, unknown>,
  config: ServiceConfig,
  hasPageInfo: boolean,
): Promise<Result<Issue[]>> {
  const allIssues: Issue[] = [];
  let cursor: string | null = null;

  for (;;) {
    const variables = { ...baseVars, after: cursor };
    const gqlResult = await graphql(query, variables, config);
    if (!gqlResult.ok) return gqlResult;

    const body = gqlResult.value;

    // Check for GraphQL-level errors
    if (Array.isArray(body['errors'])) {
      return {
        ok: false,
        error: new TypedError(
          'linear_graphql_errors',
          `Linear GraphQL returned ${(body['errors'] as unknown[]).length} error(s)`,
          body['errors'],
        ),
      };
    }

    const issuesPayload = extractIssuesRoot(body);
    if (issuesPayload === null) {
      return {
        ok: false,
        error: new TypedError('linear_unknown_payload', 'Unexpected response shape from Linear'),
      };
    }

    const nodes = extractNodesFromIssues(issuesPayload);
    if (nodes === null) {
      return {
        ok: false,
        error: new TypedError('linear_unknown_payload', 'Unexpected response shape from Linear'),
      };
    }

    for (const node of nodes) {
      const issue = normalizeIssue(node);
      if (issue) allIssues.push(issue);
    }

    if (!hasPageInfo) break;

    const pageInfo = extractPageInfo(issuesPayload);
    if (pageInfo === null) break;

    if (!pageInfo.hasNextPage) break;

    if (!pageInfo.endCursor) {
      return {
        ok: false,
        error: new TypedError(
          'linear_missing_end_cursor',
          'Linear pagination indicates next page but endCursor is missing',
        ),
      };
    }

    cursor = pageInfo.endCursor;
  }

  return { ok: true, value: allIssues };
}

// ── Response shape helpers ──

function extractIssuesRoot(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const data = body['data'];
  if (data == null || typeof data !== 'object') return null;
  const issues = (data as Record<string, unknown>)['issues'];
  if (issues == null || typeof issues !== 'object') return null;
  return issues as Record<string, unknown>;
}

function extractNodes(
  body: Record<string, unknown>,
): Record<string, unknown>[] | null {
  const issuesRoot = extractIssuesRoot(body);
  if (issuesRoot === null) return null;
  return extractNodesFromIssues(issuesRoot);
}

function extractNodesFromIssues(
  issuesRoot: Record<string, unknown>,
): Record<string, unknown>[] | null {
  const nodes = issuesRoot['nodes'];
  if (!Array.isArray(nodes)) return null;
  return nodes as Record<string, unknown>[];
}

function extractPageInfo(
  issuesRoot: Record<string, unknown>,
): PageInfo | null {
  const pi = issuesRoot['pageInfo'];
  if (pi == null || typeof pi !== 'object') return null;
  const info = pi as Record<string, unknown>;
  return {
    hasNextPage: info['hasNextPage'] === true,
    endCursor: typeof info['endCursor'] === 'string' ? info['endCursor'] : null,
  };
}
