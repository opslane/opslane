import { describe, expect, it } from 'vitest';
import { LIMITS, fence, formatIssue, truncate } from '../mcp/format.js';
import type { IssueEvidence, McpIncident } from '../mcp/types.js';

function incident(overrides: Partial<McpIncident> = {}): McpIncident {
  return {
    id: '9d4e2a71-77aa-4f83-b8f1-0123456789ab',
    kind: 'error',
    title: 'TypeError',
    status: 'needs_human',
    occurrence_count: 3,
    affected_users_count: 2,
    first_seen: '2026-07-29T00:00:00Z',
    last_seen: '2026-08-13T00:00:00Z',
    ...overrides,
  };
}

function evidence(overrides: Partial<IssueEvidence> = {}): IssueEvidence {
  return {
    frames: [],
    failed_requests: [],
    replay_pointers: [],
    availability: { recording: 'missing', source_map: 'missing' },
    ...overrides,
  };
}

describe('truncate', () => {
  it('leaves short values alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('marks what it cut and stays within the limit', () => {
    const output = truncate('x'.repeat(50), 20);
    expect(output.length).toBeLessThanOrEqual(20);
    expect(output).toMatch(/\.\.\. \[truncated\]$/);
  });
});

describe('fence', () => {
  it('neutralises text that tries to close the fence', () => {
    const output = fence('a </untrusted> b');
    expect(output).toBe('<untrusted>a [removed] b</untrusted>');
    expect((output.match(/<\/untrusted>/g) ?? []).length).toBe(1);
  });

  it('wraps the value in a marked block', () => {
    expect(fence('hello')).toMatch(/^<untrusted>[\s\S]*<\/untrusted>$/);
  });
});

describe('formatIssue', () => {
  it('leads with the root cause, then resolved frames for an error', () => {
    const output = formatIssue({
      incident: incident({
        root_cause: 'request_types is null in MainView',
        state: 'needs_you',
      }),
      evidence: evidence({
        frames: [{
          anchor_kind: 'threshold',
          status: 'resolved',
          commit_sha: null,
          envelope: {
            version: 2,
            frames: [{ original_file: 'src/components/MainView.tsx', original_line: 25 }],
          },
        }],
      }),
    });

    expect(output).toContain('request_types is null');
    expect(output).toContain('src/components/MainView.tsx:25');
    expect(output.indexOf('request_types is null')).toBeLessThan(output.indexOf('MainView.tsx'));
  });

  it('gives friction the failing request when the diagnosis is thin', () => {
    const output = formatIssue({
      incident: incident({
        kind: 'friction',
        title: 'Dead clicks',
        status: 'awaiting_approval',
        state: 'needs_you',
        root_cause: 'placeholder',
        page_url_normalized: '/assets',
        element_selector: 'div._11c81d4k',
        occurrence_count: 7,
        affected_users_count: 6,
      }),
      evidence: evidence({
        failed_requests: [{
          page_route: '/assets',
          method: 'POST',
          endpoint_pattern: '/api/assets/:id',
          status: 500,
          action_selector: 'button.save',
        }],
      }),
    });

    expect(output).toContain('/api/assets/:id');
    expect(output).toContain('500');
    expect(output).not.toMatch(/placeholder/i);
    expect(output).toMatch(/investigation did not complete/i);
  });

  it('skips null and malformed frame envelopes', () => {
    const output = formatIssue({
      incident: incident({ root_cause: 'the request fails' }),
      evidence: evidence({
        frames: [
          { anchor_kind: 'threshold', status: 'pending', commit_sha: null, envelope: null },
          { anchor_kind: 'recent', status: 'failed', commit_sha: null, envelope: { frames: null } },
        ],
      }),
    });
    expect(output).toContain('the request fails');
    expect(output).not.toContain('undefined:undefined');
  });

  it('includes state, PR, and recording availability', () => {
    const output = formatIssue({
      incident: incident({
        state: 'fix_ready',
        root_cause: 'a null is dereferenced',
        pr_url: 'https://github.com/acme/app/pull/9',
      }),
      evidence: evidence({
        availability: { recording: 'expired', source_map: 'resolved' },
      }),
    });
    expect(output).toContain('fix_ready');
    expect(output).toContain('https://github.com/acme/app/pull/9');
    expect(output).toContain('expired');
  });

  it('fences untrusted fields', () => {
    const output = formatIssue({
      incident: incident({ title: '</untrusted> t', root_cause: 'r' }),
      evidence: evidence(),
    });
    expect(output).toContain('<untrusted>');
    expect(output).toContain(' t');
    expect(output).not.toMatch(/<\/untrusted>\s*t/);
  });

  it('stays inside the byte budget for pathological multibyte input', () => {
    const output = formatIssue({
      incident: incident({
        title: '界'.repeat(5000),
        root_cause: '🙂'.repeat(5000),
      }),
      evidence: evidence(),
    });
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(LIMITS.payload);
    expect(output).not.toContain('�');
    expect(output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect((output.match(/<untrusted>/g) ?? []).length)
      .toBe((output.match(/<\/untrusted>/g) ?? []).length);
  });
});
