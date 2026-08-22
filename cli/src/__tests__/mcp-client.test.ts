import { beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.hoisted(() => vi.fn());
vi.mock('../authed-fetch.js', () => ({ authedFetch }));
vi.mock('../agent-credentials.js', () => ({
  resolveCredentials: async () => ({
    org_id: 'o',
    project_id: 'proj-1',
    api_key: 'k',
    repo: 'acme/app',
    api_url: 'https://api.test',
  }),
}));
vi.mock('../config.js', () => ({ defaultApiUrl: () => 'https://api.test' }));

import { buildIncidentUrl, createOpslaneClient, parseIncidentId } from '../mcp/client.js';

function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('parseIncidentId', () => {
  const id = '9d4e2a71-77aa-4f83-b8f1-0123456789ab';

  it('accepts a bare uuid', () => {
    expect(parseIncidentId(id)).toBe(id);
  });

  it('extracts the uuid from a dashboard url', () => {
    expect(parseIncidentId(`https://app.example.com/issues/${id}?project=abc`)).toBe(id);
  });

  it('rejects a prefix', () => {
    expect(() => parseIncidentId('9d4e2a71')).toThrow(/full UUID/i);
  });

  it('rejects unrelated text', () => {
    expect(() => parseIncidentId('the field container one')).toThrow(/full UUID/i);
  });
});

describe('buildIncidentUrl', () => {
  it('joins without doubling slashes', () => {
    expect(buildIncidentUrl('https://api.example.com/', 'p1', 'i1'))
      .toBe('https://api.example.com/api/v1/projects/p1/incidents/i1');
  });
});

describe('OpslaneClient v2', () => {
  beforeEach(() => authedFetch.mockReset());

  it('returns an empty digest rather than throwing when none was delivered', async () => {
    authedFetch.mockResolvedValue(res({ run_date: null, cards: [] }));
    const client = await createOpslaneClient({ cwd: '/tmp' });

    const digest = await client.latestDigest();

    expect(digest.cards).toEqual([]);
    expect(authedFetch.mock.calls.at(-1)![0]).toContain('/projects/proj-1/digest/latest');
  });

  it('reads the evidence bundle', async () => {
    authedFetch.mockResolvedValue(res({
      frames: [{ anchor_kind: 'threshold', status: 'resolved', envelope: {}, commit_sha: null }],
      failed_requests: [],
      replay_pointers: [],
      availability: { recording: 'available', source_map: 'resolved' },
    }));
    const client = await createOpslaneClient({ cwd: '/tmp' });

    const evidence = await client.issueEvidence('3f2504e0-4f89-11d3-9a0c-0305e82c3301');

    expect(evidence.frames[0]!.status).toBe('resolved');
    expect(authedFetch.mock.calls.at(-1)![0]).toContain('/evidence');
  });

  it('posts the PR URL when linking', async () => {
    authedFetch.mockResolvedValue(res({ id: 'i' }));
    const client = await createOpslaneClient({ cwd: '/tmp' });

    await client.linkPr(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'https://github.com/acme/app/pull/42',
    );

    const [, options] = authedFetch.mock.calls.at(-1)!;
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({
      url: 'https://github.com/acme/app/pull/42',
    });
  });

  it('surfaces the API message when linking is refused', async () => {
    authedFetch.mockResolvedValue(res({
      error: "that pull request is not in this project's repository",
    }, 422));
    const client = await createOpslaneClient({ cwd: '/tmp' });

    await expect(client.linkPr(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'https://github.com/other/app/pull/1',
    )).rejects.toThrow(/not in this project's repository/);
  });
});
