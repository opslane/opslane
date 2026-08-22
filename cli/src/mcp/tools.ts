import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OpslaneClient } from './client.js';
import { parseIncidentId } from './client.js';
import { toDigestFormatInput } from './digest.js';
import { formatDigest, formatIssue } from './format.js';

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

export function registerTools(server: McpServer, client: OpslaneClient): void {
  server.registerTool(
    'opslane_digest',
    {
      description:
        'The issues selected for the latest delivered Opslane digest, as facts. ' +
        'Start here when working the daily digest.',
      inputSchema: {},
    },
    async () => {
      const digest = await client.latestDigest();
      return text(formatDigest(toDigestFormatInput(digest, client.projectLabel)));
    },
  );

  server.registerTool(
    'opslane_issue',
    {
      description:
        'Everything Opslane knows about one issue, including its diagnosis, ' +
        'resolved source frames, failing requests, state, and pull request.',
      inputSchema: {
        id: z.string().describe('Full incident UUID, or a dashboard URL containing it'),
      },
    },
    async ({ id }) => {
      const incidentId = parseIncidentId(id);
      const [incident, evidence] = await Promise.all([
        client.getIncident(incidentId),
        client.issueEvidence(incidentId),
      ]);
      return text(formatIssue({ incident, evidence }));
    },
  );

  server.registerTool(
    'opslane_link_pr',
    {
      description:
        'Record a GitHub pull request on an Opslane issue. This marks a PR as ' +
        'in flight; it does not claim the issue is resolved.',
      inputSchema: {
        id: z.string().describe('Full incident UUID, or a dashboard URL containing it'),
        url: z.string().describe('GitHub pull request URL'),
      },
    },
    async ({ id, url }) => {
      const incidentId = parseIncidentId(id);
      try {
        await client.linkPr(incidentId, url);
        return text(`Linked ${url} to ${incidentId}. The issue will resolve through the merge workflow.`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'unknown error';
        return text(`Could not link the pull request: ${message}`);
      }
    },
  );
}
