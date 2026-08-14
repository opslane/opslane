import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpslaneClient } from './client.js';
import { parseIncidentId } from './client.js';
import { formatIssue, formatWorklist } from './format.js';
import type { McpIncident } from './types.js';

const WORKLIST_CAP = 100;
const FINISHED = new Set(['resolved', 'archived', 'merged']);

/** ListIncidents returns digest readiness but does not filter on it, so
 * ineligible incidents (quarantined placeholder verdicts among them) arrive
 * here and are dropped locally. */
export function selectWorklist(incidents: McpIncident[]): {
  rows: McpIncident[];
  droppedIneligible: number;
} {
  let droppedIneligible = 0;
  const rows = incidents.filter((incident) => {
    if (incident.kind !== 'friction') return false;
    if (FINISHED.has(incident.status)) return false;
    if (incident.investigation_readiness === 'ineligible') {
      droppedIneligible += 1;
      return false;
    }
    return true;
  });
  return { rows, droppedIneligible };
}

/** anchor_ms is absolute client-clock epoch milliseconds, which is exactly the
 * dashboard's ?t= contract. The credential store holds only the API origin, so
 * a link is produced only when OPSLANE_DASHBOARD_URL names the dashboard. */
export function recordingLine(
  incident: McpIncident,
  dashboardUrl: string | null,
): string | null {
  const session = incident.watchable_session;
  if (!session) return null;
  if (!dashboardUrl) {
    return `  Recording: session ${session.session_id} at ${session.anchor_ms} (set OPSLANE_DASHBOARD_URL for a link)`;
  }
  const origin = dashboardUrl.replace(/\/+$/, '');
  return `  Watch it: ${origin}/sessions/${session.session_id}?t=${session.anchor_ms}`;
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

export function registerTools(server: McpServer, client: OpslaneClient): void {
  server.registerTool(
    'opslane_worklist',
    {
      description:
        'Friction issues in this project that need a person. Approximates the ' +
        'daily Slack digest; ordering and contents will not match it exactly.',
      inputSchema: {},
    },
    async () => {
      const incidents = await client.listFriction();
      const { rows, droppedIneligible } = selectWorklist(incidents);
      return text(
        formatWorklist(rows, {
          projectLabel: client.projectLabel,
          hitCap: incidents.length >= WORKLIST_CAP,
          droppedIneligible,
        }),
      );
    },
  );

  server.registerTool(
    'opslane_issue',
    {
      description:
        'Everything Opslane knows about one friction issue. Accepts the full ' +
        'incident UUID or the dashboard URL from the digest.',
      inputSchema: {
        id: z.string().describe('Full incident UUID, or the dashboard URL containing it'),
      },
    },
    async ({ id }) => {
      const incident = await client.getIncident(parseIncidentId(id));
      if (incident.kind !== 'friction') {
        return text(notFriction(incident.id));
      }
      return text(formatIssue(incident, recordingLine(incident, client.dashboardUrl)));
    },
  );

  server.registerTool(
    'opslane_resolve',
    {
      description:
        'Mark a friction issue resolved. Nothing closes friction issues ' +
        'automatically, so call this once a fix is open or the issue is judged ' +
        'not worth fixing.',
      inputSchema: {
        id: z.string().describe('Full incident UUID, or the dashboard URL containing it'),
      },
    },
    async ({ id }) => {
      const incidentId = parseIncidentId(id);
      // Fetch first: the API will happily resolve an error incident, and this
      // version has no business touching those.
      const incident = await client.getIncident(incidentId);
      if (incident.kind !== 'friction') {
        return text(notFriction(incidentId));
      }
      await client.resolveIncident(incidentId);
      return text(`Resolved ${incidentId}. It will not appear in the worklist again.`);
    },
  );
}

function notFriction(id: string): string {
  return (
    `${id} is not a friction issue. This version covers friction only, because ` +
    'the symbolicated stack an error needs is not exposed by the API yet. Open ' +
    'it in the dashboard instead.'
  );
}
