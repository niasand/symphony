import { describe, it, expect } from 'vitest';
import { normalizeIssue } from '../src/tracker/normalizer.js';

describe('tracker/normalizer — normalizeIssue', () => {
  it('maps all fields correctly', () => {
    const raw = {
      id: 'abc-123',
      identifier: 'SYM-1',
      title: 'Fix crash',
      description: 'App crashes on launch',
      priority: 2,
      state: { name: 'In Progress' },
      branchName: 'fix/crash',
      url: 'https://linear.app/issue/SYM-1',
      labels: {
        nodes: [{ name: 'Bug' }, { name: 'Critical' }],
      },
      inverseRelations: {
        nodes: [],
      },
      createdAt: '2025-03-01T10:00:00.000Z',
      updatedAt: '2025-03-02T15:30:00.000Z',
      assignee: { id: 'user-42' },
    };

    const issue = normalizeIssue(raw);

    expect(issue).not.toBeNull();
    if (!issue) return;
    expect(issue.id).toBe('abc-123');
    expect(issue.identifier).toBe('SYM-1');
    expect(issue.title).toBe('Fix crash');
    expect(issue.description).toBe('App crashes on launch');
    expect(issue.priority).toBe(2);
    expect(issue.state).toBe('In Progress');
    expect(issue.branch_name).toBe('fix/crash');
    expect(issue.url).toBe('https://linear.app/issue/SYM-1');
    expect(issue.labels).toEqual(['bug', 'critical']);
    expect(issue.blocked_by).toEqual([]);
    expect(issue.created_at).toEqual(new Date('2025-03-01T10:00:00.000Z'));
    expect(issue.updated_at).toEqual(new Date('2025-03-02T15:30:00.000Z'));
    expect(issue.assignee_id).toBe('user-42');
  });

  it('converts labels to lowercase', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-2',
      title: 'Test',
      state: { name: 'Todo' },
      labels: {
        nodes: [{ name: 'Feature' }, { name: 'UI' }, { name: 'BACKEND' }],
      },
    };

    const issue = normalizeIssue(raw);
    expect(issue).not.toBeNull();
    if (!issue) return;
    expect(issue.labels).toEqual(['feature', 'ui', 'backend']);
  });

  it('extracts blockers from inverseRelations type=blocks', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-3',
      title: 'Blocked issue',
      state: { name: 'Todo' },
      inverseRelations: {
        nodes: [
          {
            type: 'blocks',
            issue: {
              id: 'blocker-id',
              identifier: 'SYM-100',
              state: { name: 'In Progress' },
            },
          },
          {
            type: 'relates_to',
            issue: {
              id: 'rel-id',
              identifier: 'SYM-200',
              state: { name: 'Done' },
            },
          },
        ],
      },
    };

    const issue = normalizeIssue(raw);
    expect(issue).not.toBeNull();
    if (!issue) return;
    expect(issue.blocked_by).toHaveLength(1);
    expect(issue.blocked_by[0]).toEqual({
      id: 'blocker-id',
      identifier: 'SYM-100',
      state: 'In Progress',
    });
  });

  it('returns priority as integer or null', () => {
    // Valid integer priority
    const withPriority = normalizeIssue({
      id: 'id1', identifier: 'SYM-4', title: 'T', state: { name: 'Todo' }, priority: 3,
    });
    expect(withPriority).not.toBeNull();
    if (!withPriority) return;
    expect(withPriority.priority).toBe(3);

    // Non-integer
    const withFloat = normalizeIssue({
      id: 'id2', identifier: 'SYM-5', title: 'T', state: { name: 'Todo' }, priority: 2.5,
    });
    expect(withFloat).not.toBeNull();
    if (!withFloat) return;
    expect(withFloat.priority).toBeNull();

    // String
    const withString = normalizeIssue({
      id: 'id3', identifier: 'SYM-6', title: 'T', state: { name: 'Todo' }, priority: 'high',
    });
    expect(withString).not.toBeNull();
    if (!withString) return;
    expect(withString.priority).toBeNull();

    // Missing
    const missing = normalizeIssue({
      id: 'id4', identifier: 'SYM-7', title: 'T', state: { name: 'Todo' },
    });
    expect(missing).not.toBeNull();
    if (!missing) return;
    expect(missing.priority).toBeNull();
  });

  it('parses ISO 8601 dates', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-8',
      title: 'Date test',
      state: { name: 'Todo' },
      createdAt: '2025-01-15T10:30:00.000Z',
      updatedAt: '2025-02-20T14:00:00.000Z',
    };

    const issue = normalizeIssue(raw);
    expect(issue).not.toBeNull();
    if (!issue) return;
    expect(issue.created_at).toBeInstanceOf(Date);
    expect(issue.created_at!.toISOString()).toBe('2025-01-15T10:30:00.000Z');
    expect(issue.updated_at).toBeInstanceOf(Date);
    expect(issue.updated_at!.toISOString()).toBe('2025-02-20T14:00:00.000Z');
  });

  it('returns null for missing required fields (id)', () => {
    const raw = {
      identifier: 'SYM-10',
      title: 'Test',
      state: { name: 'Todo' },
    };
    expect(normalizeIssue(raw)).toBeNull();
  });

  it('returns null for missing required fields (identifier)', () => {
    const raw = {
      id: 'id1',
      title: 'Test',
      state: { name: 'Todo' },
    };
    expect(normalizeIssue(raw)).toBeNull();
  });

  it('returns null for missing required fields (title)', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-10',
      state: { name: 'Todo' },
    };
    expect(normalizeIssue(raw)).toBeNull();
  });

  it('returns null for missing required fields (state)', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-10',
      title: 'Test',
    };
    expect(normalizeIssue(raw)).toBeNull();
  });

  it('returns null when state is not an object with name', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-10',
      title: 'Test',
      state: 'just-a-string',
    };
    expect(normalizeIssue(raw)).toBeNull();
  });

  it('returns empty arrays when labels/inverseRelations are missing', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-10',
      title: 'Test',
      state: { name: 'Todo' },
    };

    const issue = normalizeIssue(raw);
    expect(issue).not.toBeNull();
    if (!issue) return;
    expect(issue.labels).toEqual([]);
    expect(issue.blocked_by).toEqual([]);
  });

  it('returns null for invalid date strings', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-10',
      title: 'Test',
      state: { name: 'Todo' },
      createdAt: 'not-a-date',
    };

    const issue = normalizeIssue(raw);
    expect(issue).not.toBeNull();
    if (!issue) return;
    expect(issue.created_at).toBeNull();
  });

  it('returns null description for non-string values', () => {
    const raw = {
      id: 'id1',
      identifier: 'SYM-10',
      title: 'Test',
      state: { name: 'Todo' },
      description: 123,
    };

    const issue = normalizeIssue(raw);
    expect(issue).not.toBeNull();
    if (!issue) return;
    expect(issue.description).toBeNull();
  });
});
