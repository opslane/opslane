import { describe, expect, it } from 'vitest';
import type { OpslaneClient } from '../mcp/client.js';
import { registerTools } from '../mcp/tools.js';

type ToolResult = { content: Array<{ text: string }> };

function fakeServer() {
  const registered = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  return {
    registered,
    registerTool(
      name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) {
      registered.set(name, handler);
    },
  };
}

function fakeClient(overrides: Partial<OpslaneClient> = {}): OpslaneClient {
  return {
    projectId: 'p',
    projectLabel: 'p (acme/app)',
    dashboardUrl: null,
    latestDigest: async () => ({
      run_date: '2026-08-21',
      cards: [{
        episode_id: 'e',
        incident_id: 'i-1',
        title: 't',
        label: 'new',
        copy: 'c',
        action: 'a',
        affected_users: 3,
        accounts: [],
      }],
    }),
    getIncident: async () => ({
      id: 'i-1',
      kind: 'error',
      title: 't',
      status: 'needs_human',
      root_cause: 'r',
      occurrence_count: 1,
      affected_users_count: 1,
      first_seen: '',
      last_seen: '',
    }),
    issueEvidence: async () => ({
      frames: [],
      failed_requests: [],
      replay_pointers: [],
      availability: { recording: 'missing', source_map: 'missing' },
    }),
    linkPr: async () => undefined,
    ...overrides,
  };
}

describe('registerTools v2', () => {
  it('registers exactly the three tools', () => {
    const server = fakeServer();
    registerTools(server as never, fakeClient());
    expect([...server.registered.keys()].sort()).toEqual([
      'opslane_digest',
      'opslane_issue',
      'opslane_link_pr',
    ]);
  });

  it('renders the delivered digest', async () => {
    const server = fakeServer();
    registerTools(server as never, fakeClient());
    const result = await server.registered.get('opslane_digest')!({});
    expect(result.content[0]!.text).toContain('i-1');
  });

  it('combines incident state and evidence', async () => {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const server = fakeServer();
    registerTools(server as never, fakeClient({
      getIncident: async () => ({
        id,
        kind: 'error',
        title: 'TypeError',
        status: 'needs_human',
        root_cause: 'request_types is null',
        occurrence_count: 2,
        affected_users_count: 1,
        first_seen: '',
        last_seen: '',
      }),
    }));
    const result = await server.registered.get('opslane_issue')!({ id });
    expect(result.content[0]!.text).toContain('request_types is null');
  });

  it('surfaces a link refusal as readable text', async () => {
    const server = fakeServer();
    registerTools(server as never, fakeClient({
      linkPr: async () => {
        throw new Error("not in this project's repository");
      },
    }));
    const result = await server.registered.get('opslane_link_pr')!({
      id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      url: 'https://github.com/other/app/pull/1',
    });
    expect(result.content[0]!.text).toContain("not in this project's repository");
  });
});
