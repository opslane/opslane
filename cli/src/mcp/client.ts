import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { authedFetch } from '../authed-fetch.js';
import { resolveCredentials } from '../agent-credentials.js';
import { defaultApiUrl } from '../config.js';
import type { McpIncident } from './types.js';

const run = promisify(execFile);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Full UUID or a dashboard URL containing one. Prefixes are unsupported:
 * incident lookup is an exact match and the list endpoint is capped, so nothing
 * can prove a prefix unique. */
export function parseIncidentId(input: string): string {
  const match = UUID.exec(input.trim());
  if (!match) {
    throw new Error(
      'Could not read an incident id. Pass the full UUID or the dashboard URL from the digest.',
    );
  }
  return match[0].toLowerCase();
}

export function buildIncidentUrl(apiUrl: string, projectId: string, incidentId: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/api/v1/projects/${projectId}/incidents/${incidentId}`;
}

export interface OpslaneClient {
  projectId: string;
  projectLabel: string;
  dashboardUrl: string | null;
  listFriction(): Promise<McpIncident[]>;
  getIncident(id: string): Promise<McpIncident>;
  resolveIncident(id: string): Promise<void>;
}

async function currentRepoSlug(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd });
    const match = /[/:]([^/:]+\/[^/]+?)(?:\.git)?\s*$/.exec(stdout);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

export async function createOpslaneClient(options: { cwd: string }): Promise<OpslaneClient> {
  const repo = await currentRepoSlug(options.cwd);
  // resolveCredentials returns null when a repo is given without an apiUrl
  // (agent-credentials.ts:93), so both must be passed or every tool call fails
  // before it starts. Every existing caller passes both.
  const credentials = await resolveCredentials({ repo, apiUrl: defaultApiUrl() });
  if (!credentials) {
    throw new Error(
      `No Opslane project is linked to ${repo ?? 'this directory'} at ${defaultApiUrl()}. ` +
        'Run "opslane setup" to link this repository to a project. ' +
        '"opslane login" alone only stores a user session and does not create the mapping.',
    );
  }

  const apiUrl = credentials.api_url;
  const projectId = credentials.project_id;
  const base = `${apiUrl.replace(/\/+$/, '')}/api/v1/projects/${projectId}`;

  async function readJson<T>(url: string): Promise<T> {
    const response = await authedFetch(url, { apiUrl });
    if (!response.ok) throw new Error(`Opslane API returned ${response.status} for ${url}`);
    return (await response.json()) as T;
  }

  return {
    projectId,
    projectLabel: `${projectId} (${repo ?? 'no git remote'})`,
    dashboardUrl: process.env['OPSLANE_DASHBOARD_URL'] ?? null,
    async listFriction() {
      // ListIncidents encodes a bare array, not an envelope
      // (packages/ingestion/handler/read_api.go, ListIncidents). The guard is
      // here so an unexpected shape returns nothing rather than throwing inside
      // the formatter.
      const body = await readJson<unknown>(`${base}/incidents?kind=friction`);
      return Array.isArray(body) ? (body as McpIncident[]) : [];
    },
    async getIncident(id) {
      return readJson<McpIncident>(buildIncidentUrl(apiUrl, projectId, id));
    },
    async resolveIncident(id) {
      const response = await authedFetch(
        `${buildIncidentUrl(apiUrl, projectId, id)}/resolve`,
        { apiUrl, method: 'POST' },
      );
      if (!response.ok) {
        throw new Error(`Could not resolve ${id}: Opslane API returned ${response.status}`);
      }
    },
  };
}
