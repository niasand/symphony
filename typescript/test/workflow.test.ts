import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir, writeWorkflowFile } from './helpers.js';
import { load } from '../src/workflow/loader.js';

describe('workflow/loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it('loads valid WORKFLOW.md with YAML front matter + prompt body', () => {
    const content = `---
tracker:
  kind: linear
  api_key: test-key
---
You are working on {{ issue.identifier }}.
`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({
      tracker: { kind: 'linear', api_key: 'test-key' },
    });
    expect(result.value.prompt_template).toBe('You are working on {{ issue.identifier }}.');
  });

  it('returns empty config when no front matter', () => {
    const content = `Just a plain prompt body with no YAML.`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({});
    expect(result.value.prompt_template).toBe('Just a plain prompt body with no YAML.');
  });

  it('returns missing_workflow_file error for nonexistent file', () => {
    const result = load('/nonexistent/path/WORKFLOW.md');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_workflow_file');
  });

  it('returns workflow_parse_error for invalid YAML', () => {
    const content = `---
tracker: [invalid: yaml: {broken
---
prompt body`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('workflow_parse_error');
  });

  it('returns workflow_front_matter_not_a_map for non-object YAML (array)', () => {
    const content = `---
- item1
- item2
---
prompt body`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('workflow_front_matter_not_a_map');
  });

  it('trims prompt body whitespace', () => {
    const content = `---
key: val
---

   Hello world

`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt_template).toBe('Hello world');
  });

  it('handles front matter with no body (empty prompt)', () => {
    const content = `---
key: val
---`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({ key: 'val' });
    expect(result.value.prompt_template).toBe('');
  });

  it('handles empty YAML front matter (null parsed result)', () => {
    const content = `---
---`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({});
  });

  it('treats all content as front matter when no closing delimiter', () => {
    const content = `---
key: val
another_key: true`;
    const path = writeWorkflowFile(tmpDir, content);
    const result = load(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No closing --- so everything after opening --- is treated as YAML front matter
    expect(result.value.config).toEqual({ key: 'val', another_key: true });
    expect(result.value.prompt_template).toBe('');
  });
});
