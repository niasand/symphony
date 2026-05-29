import type { Issue, BlockerRef } from '../types.js';

/**
 * Normalize a raw GraphQL issue node into the domain Issue type.
 * Returns null if required fields (id, identifier, title, state) are missing.
 */
export function normalizeIssue(raw: Record<string, unknown>): Issue | null {
  const id = typeof raw['id'] === 'string' ? raw['id'] : null;
  const identifier = typeof raw['identifier'] === 'string' ? raw['identifier'] : null;
  const title = typeof raw['title'] === 'string' ? raw['title'] : null;
  const rawState = raw['state'];
  const state =
    rawState != null && typeof rawState === 'object'
      ? (rawState as Record<string, unknown>)['name']
      : null;
  const stateStr = typeof state === 'string' ? state : null;

  if (!id || !identifier || !title || !stateStr) return null;

  const priority = parsePriority(raw['priority']);
  const description =
    raw['description'] === null || raw['description'] === undefined
      ? null
      : typeof raw['description'] === 'string'
        ? raw['description']
        : null;
  const branchName =
    raw['branchName'] === null || raw['branchName'] === undefined
      ? null
      : typeof raw['branchName'] === 'string'
        ? raw['branchName']
        : null;
  const url =
    raw['url'] === null || raw['url'] === undefined
      ? null
      : typeof raw['url'] === 'string'
        ? raw['url']
        : null;
  const labels = extractLabels(raw);
  const blockedBy = extractBlockers(raw);
  const createdAt = parseDate(raw['createdAt']);
  const updatedAt = parseDate(raw['updatedAt']);
  const assigneeId = extractAssigneeId(raw);

  return {
    id,
    identifier,
    title,
    description,
    priority,
    state: stateStr,
    branch_name: branchName,
    url,
    labels,
    blocked_by: blockedBy,
    created_at: createdAt,
    updated_at: updatedAt,
    assignee_id: assigneeId,
  };
}

function parsePriority(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}

function extractLabels(raw: Record<string, unknown>): string[] {
  const labels = raw['labels'];
  if (labels == null || typeof labels !== 'object') return [];

  const nodes = (labels as Record<string, unknown>)['nodes'];
  if (!Array.isArray(nodes)) return [];

  return nodes
    .filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null)
    .map((n) => n['name'])
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.toLowerCase());
}

function extractBlockers(raw: Record<string, unknown>): BlockerRef[] {
  const relations = raw['inverseRelations'];
  if (relations == null || typeof relations !== 'object') return [];

  const nodes = (relations as Record<string, unknown>)['nodes'];
  if (!Array.isArray(nodes)) return [];

  const result: BlockerRef[] = [];

  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;

    const relType = (node as Record<string, unknown>)['type'];
    if (typeof relType !== 'string') continue;
    if (relType.trim().toLowerCase() !== 'blocks') continue;

    const issue = (node as Record<string, unknown>)['issue'];
    if (typeof issue !== 'object' || issue === null) continue;

    const blockerIssue = issue as Record<string, unknown>;
    const blockerState = blockerIssue['state'];
    const blockerStateName =
      blockerState != null && typeof blockerState === 'object'
        ? (blockerState as Record<string, unknown>)['name']
        : null;

    result.push({
      id: typeof blockerIssue['id'] === 'string' ? blockerIssue['id'] : null,
      identifier:
        typeof blockerIssue['identifier'] === 'string' ? blockerIssue['identifier'] : null,
      state: typeof blockerStateName === 'string' ? blockerStateName : null,
    });
  }

  return result;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d;
}

function extractAssigneeId(raw: Record<string, unknown>): string | null {
  const assignee = raw['assignee'];
  if (assignee == null || typeof assignee !== 'object') return null;
  const id = (assignee as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}

export function normalizeIssueState(stateName: string): string {
  return stateName.toLowerCase().trim();
}
