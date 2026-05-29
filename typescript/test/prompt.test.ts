import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/prompt/builder.js';
import { sampleIssue } from './helpers.js';

describe('prompt/builder — buildPrompt', () => {
  it('renders issue fields in template', () => {
    const issue = sampleIssue();
    const template = 'Working on {{ issue.identifier }}: {{ issue.title }}';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Working on SYM-42: Fix login bug');
  });

  it('renders attempt variable', () => {
    const issue = sampleIssue();
    const template = 'Attempt {{ attempt }} for {{ issue.identifier }}';
    const result = buildPrompt(issue, 3, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Attempt 3 for SYM-42');
  });

  it('renders null attempt as empty string', () => {
    const issue = sampleIssue();
    const template = 'Attempt: {{ attempt }}';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Liquid renders null as empty string in strict mode
    expect(result.value).toContain('Attempt:');
  });

  it('returns default prompt for empty template', () => {
    const issue = sampleIssue();
    const result = buildPrompt(issue, null, '');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('You are working on an issue from Linear.');
  });

  it('returns default prompt for whitespace-only template', () => {
    const issue = sampleIssue();
    const result = buildPrompt(issue, null, '   ');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('You are working on an issue from Linear.');
  });

  it('fails on unknown variables (strict mode)', () => {
    const issue = sampleIssue();
    const template = '{{ issue.nonexistent_field }}';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('template_render_error');
  });

  it('handles nested arrays (labels)', () => {
    const issue = sampleIssue({ labels: ['bug', 'auth', 'urgent'] });
    const template = 'Labels: {{ issue.labels | join: ", " }}';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Labels: bug, auth, urgent');
  });

  it('handles blocked_by array', () => {
    const issue = sampleIssue({
      blocked_by: [
        { id: 'b1', identifier: 'SYM-10', state: 'Done' },
        { id: 'b2', identifier: 'SYM-11', state: 'In Progress' },
      ],
    });
    const template = 'Blocked by {{ issue.blocked_by | size }} issues';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Blocked by 2 issues');
  });

  it('converts Date to ISO string', () => {
    const issue = sampleIssue({
      created_at: new Date('2025-06-15T08:30:00.000Z'),
    });
    const template = 'Created: {{ issue.created_at }}';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Created: 2025-06-15T08:30:00.000Z');
  });

  it('handles null description field', () => {
    const issue = sampleIssue({ description: null });
    const template = 'Desc: {{ issue.description }}';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // null renders as empty string
    expect(result.value).toBe('Desc: ');
  });

  it('renders priority number', () => {
    const issue = sampleIssue({ priority: 3 });
    const template = 'Priority: {{ issue.priority }}';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Priority: 3');
  });

  it('returns template_parse_error for malformed Liquid syntax', () => {
    const issue = sampleIssue();
    const template = '{{ issue.title';
    const result = buildPrompt(issue, null, template);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('template_parse_error');
  });
});
