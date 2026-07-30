import { execSync } from 'node:child_process';
import { canonicalOrigin } from './origin.js';
import { jsonOutput, exitWithStatus } from './output.js';
import {
  defaultCredentialsPath,
  resolveCredentials,
  saveAgentCredentials,
  type AgentCredentials,
} from './agent-credentials.js';
import {
  defaultPendingDir,
  deletePendingSession,
  loadPendingSession,
  savePendingSession,
  validatePollId,
  type PendingSession,
} from './pending.js';
import { defaultTokenPath, loadTokensFrom } from './auth.js';
import { defaultApiUrl } from './config.js';
import {
  pollSessionOnce,
  responseJSON,
  retryAfterSeconds,
  type JsonBody,
} from './agent-protocol.js';

const POLL_INTERVAL_MS = 3_000;
const BLOCKING_TIMEOUT_SECONDS = 15 * 60;
const RESUME_TIMEOUT_SECONDS = 60;

export interface SetupOptions {
  start?: boolean;
  poll?: string;
  timeout?: number | string;
  force?: boolean;
  repo?: string;
  apiUrl?: string;
  repoUrl?: string;
  agentName?: string;
  cwd?: string;
  credentialsPath?: string;
  pendingDir?: string;
  tokenPath?: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export function normalizeRepoURL(remoteURL: string): string | null {
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(remoteURL)) return remoteURL;
  const httpsMatch = remoteURL.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1] ?? null;
  const sshMatch = remoteURL.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  return sshMatch?.[1] ?? null;
}

export function detectRepoFromGit(cwd?: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return normalizeRepoURL(remote);
  } catch {
    return null;
  }
}

function timeoutSeconds(value: number | string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stderrJSON(body: JsonBody): void {
  console.error(JSON.stringify(body, null, 2));
}

function usageError(message: string): never {
  return exitWithStatus('usage_error', { message }, 1);
}

function selectedRepo(options: SetupOptions): string | null {
  const explicit = options.repo ?? options.repoUrl;
  return explicit ? normalizeRepoURL(explicit) : detectRepoFromGit(options.cwd);
}

async function validateExistingCredential(
  creds: AgentCredentials,
  fetchFn: typeof fetch,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const response = await fetchFn(`${creds.api_url}/api/v1/ingest/ping`, {
      method: 'POST',
      headers: { 'X-API-Key': creds.api_key },
    });
    if (response.ok) return 'valid';
    return response.status === 401 || response.status === 403 ? 'invalid' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

async function pollLoop(
  pending: PendingSession,
  timeout: number,
  options: SetupOptions,
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const pendingDir = options.pendingDir ?? defaultPendingDir();
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeout * 1_000;
  let reachedServer = false;
  let waitingForApp = false;

  while (Date.now() < deadline) {
    const result = await pollSessionOnce({
      apiUrl: pending.api_url,
      sessionId: pending.poll_id,
      pollToken: pending.poll_token,
      fetchFn,
    });

    if (result.status === 'unreachable') {
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleepFn(Math.min(interval, remaining));
      continue;
    }
    reachedServer = true;

    if (result.status === 'pending') {
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleepFn(Math.min(interval, remaining));
      continue;
    }

    if (result.status === 'rate_limited') {
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await sleepFn(Math.min((result.retryAfterSeconds ?? 60) * 1_000, remaining));
      }
      continue;
    }

    if (result.status === 'provisioned' || result.status === 'key_ok'
      || result.status === 'app_reporting' || result.status === 'completed') {
      const apiKey = result.apiKey;
      if (!apiKey && result.status !== 'app_reporting') {
        await deletePendingSession(pending.poll_id, pendingDir);
        return exitWithStatus('key_unavailable', {
          project_id: result.projectId ?? undefined,
          remediation: 'run "opslane onboard" in this repo to mint a replacement key, then redeploy',
        }, 1);
      }
      const orgId = result.orgId;
      const projectId = result.projectId;
      const repo = result.repo ?? pending.repo;
      if (!orgId || !projectId) {
        return exitWithStatus('internal_error', { message: 'provisioned response omitted project credentials' }, 1);
      }
      if (!apiKey) {
        const saved = await resolveCredentials({ apiUrl: pending.api_url, repo, filePath: credentialsPath });
        if (!saved || saved.project_id !== projectId || saved.org_id !== orgId) {
          await deletePendingSession(pending.poll_id, pendingDir);
          return exitWithStatus('key_unavailable', {
            project_id: result.projectId ?? undefined,
            remediation: 'run "opslane onboard" in this repo to mint a replacement key, then redeploy',
          }, 1);
        }
      }
      if (apiKey) {
        try {
          await saveAgentCredentials({
            org_id: orgId,
            project_id: projectId,
            api_key: apiKey,
            repo,
            api_url: pending.api_url,
          }, credentialsPath);
        } catch {
          return exitWithStatus('internal_error', {
            message: 'could not save provisioned credentials; retry this poll while the key is available',
          }, 1);
        }
      }

      if (result.status !== 'app_reporting' && result.status !== 'completed') {
        waitingForApp = true;
        const remaining = deadline - Date.now();
        if (remaining > 0) await sleepFn(Math.min(interval, remaining));
        continue;
      }
      await deletePendingSession(pending.poll_id, pendingDir);
      jsonOutput({
        status: 'completed',
        api_key: apiKey ?? undefined,
        org_id: orgId,
        project_id: projectId,
        repo,
      });
      return;
    }

    if (result.status === 'failed') {
      await deletePendingSession(pending.poll_id, pendingDir);
      return exitWithStatus('failed', {
        failure_reason: result.failureReason ?? undefined,
        message: result.message ?? undefined,
      }, 1);
    }

    if (result.status === 'not_found') {
      await deletePendingSession(pending.poll_id, pendingDir);
      return exitWithStatus('not_found', { poll_id: pending.poll_id }, 1);
    }

    if (result.status === 'expired') {
      await deletePendingSession(pending.poll_id, pendingDir);
      return exitWithStatus('expired', { remediation: 're-run setup' }, 1);
    }

    if (result.status === 'internal_error') {
      return exitWithStatus('internal_error', { message: result.message ?? 'server error' }, 1);
    }

    return exitWithStatus('internal_error', {
      message: 'unrecognized server status',
      server_status: result.status === 'unknown' ? result.serverStatus : result.status,
    }, 1);
  }

  if (!reachedServer) {
    return exitWithStatus('api_unreachable', { api_url: pending.api_url }, 1);
  }
  jsonOutput({
    status: 'pending',
    poll_id: pending.poll_id,
    message: waitingForApp
      ? 'Waiting for your app to report. Start it locally, then run setup --poll again.'
      : 'Authorization is still pending. Run setup --poll again.',
  });
}

async function resumePolling(options: SetupOptions): Promise<void> {
  const timeout = timeoutSeconds(options.timeout, RESUME_TIMEOUT_SECONDS);
  if (timeout === null) return usageError('--timeout must be a finite positive number');
  const pollId = options.poll ?? '';
  try {
    validatePollId(pollId);
  } catch {
    return usageError('--poll must be a UUID');
  }
  const pending = await loadPendingSession(pollId, options.pendingDir ?? defaultPendingDir());
  if (!pending) return exitWithStatus('not_found', { poll_id: pollId }, 1);
  await pollLoop(pending, timeout, options);
}

interface ProjectResponse { id: string; github_repo?: string | null }
interface EnvironmentResponse { id: string; name: string }

export async function setup(options: SetupOptions = {}): Promise<void> {
  if (options.start && options.poll) return usageError('--start and --poll cannot be used together');
  if (options.poll) return resumePolling(options);

  const blockingTimeout = timeoutSeconds(options.timeout, BLOCKING_TIMEOUT_SECONDS);
  if (blockingTimeout === null) return usageError('--timeout must be a finite positive number');
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return usageError('--api-url must be a valid http(s) URL');
  }
  const repo = selectedRepo(options);
  if (!repo) {
    return exitWithStatus('repo_not_detected', {
      message: 'Could not detect repo from git remote. Use --repo owner/repo.',
    }, 1);
  }

  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const existing = await resolveCredentials({ apiUrl, repo, filePath: credentialsPath });
  if (existing && !options.force) {
    const validity = await validateExistingCredential(existing, options.fetchFn ?? fetch);
    if (validity === 'valid') {
      jsonOutput({
        status: 'already_configured',
        org_id: existing.org_id,
        project_id: existing.project_id,
        repo: existing.repo,
      });
      return;
    }
    if (validity === 'unreachable') {
      return exitWithStatus('api_unreachable', { api_url: existing.api_url }, 1);
    }
    return exitWithStatus('credentials_invalid', {
      remediation: 'run "opslane setup --force" for a new repo, or "opslane onboard" for an existing project',
    }, 1);
  }

  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(`${apiUrl}/api/v1/agent/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: repo, agent_name: options.agentName }),
    });
  } catch {
    return exitWithStatus('api_unreachable', { api_url: apiUrl }, 1);
  }

  const body = await responseJSON(response);
  if (!body) return exitWithStatus('internal_error', { message: 'unparseable server response' }, 1);
  const status = body['status'];
  if (status === 'rate_limited' || response.status === 429) {
    return exitWithStatus('rate_limited', {
      retry_after: retryAfterSeconds(response, body),
      message: body['message'],
    }, 1);
  }
  if (status === 'already_configured') {
    if (options.force) {
      return exitWithStatus('already_configured', {
        repo,
        remediation: 'run "opslane onboard" in this repo to mint a replacement key, then redeploy',
      }, 1);
    }
    jsonOutput(body);
    return;
  }
  if (status === 'internal_error') {
    return exitWithStatus('internal_error', { message: body['message'] ?? 'server error' }, 1);
  }
  if (status !== 'auth_required' || !response.ok) {
    return exitWithStatus('internal_error', {
      message: 'unrecognized setup response',
      server_status: status,
    }, 1);
  }

  const pollId = typeof body['poll_id'] === 'string' ? body['poll_id'] : '';
  const pollToken = typeof body['poll_token'] === 'string' ? body['poll_token'] : '';
  const authUrl = typeof body['auth_url'] === 'string' ? body['auth_url'] : '';
  try { validatePollId(pollId); } catch {
    return exitWithStatus('internal_error', { message: 'server returned an invalid poll ID' }, 1);
  }
  if (!pollToken || !authUrl) {
    return exitWithStatus('internal_error', { message: 'server omitted setup credentials' }, 1);
  }
  const pending: PendingSession = {
    poll_id: pollId,
    poll_token: pollToken,
    api_url: apiUrl,
    repo,
    created_at: new Date().toISOString(),
  };
  try {
    await savePendingSession(pending, options.pendingDir ?? defaultPendingDir());
  } catch {
    return exitWithStatus('internal_error', { message: 'could not save pending setup state' }, 1);
  }

  if (options.start) {
    jsonOutput(body);
    return;
  }
  stderrJSON(body);
  await pollLoop(pending, blockingTimeout, options);
}
