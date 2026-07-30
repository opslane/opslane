import { resolveCredentials, defaultCredentialsPath } from './agent-credentials.js';
import { jsonOutput, exitWithStatus } from './output.js';
import { defaultApiUrl } from './config.js';
import { detectRepoFromGit } from './setup.js';
import { canonicalOrigin } from './origin.js';
import { authedFetch, type SessionTokenLoader } from './authed-fetch.js';

export interface VerifyOptions {
  credentialsPath?: string;
  fetchFn?: typeof fetch;
  apiUrl?: string;
  repo?: string;
  cwd?: string;
  tokenPath?: string;
  loadToken?: SessionTokenLoader;
}

export interface VerifyResult {
  status: 'ok' | 'error' | 'no_credentials';
  api_reachable: boolean;
  has_events: boolean;
  message: string;
}

export async function verifyConnection(options: VerifyOptions = {}): Promise<VerifyResult> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const fetchFn = options.fetchFn ?? fetch;

  const creds = await resolveCredentials({
    filePath: credPath,
    apiUrl: options.apiUrl ?? defaultApiUrl(),
    repo: options.repo ?? detectRepoFromGit(options.cwd),
  });
  if (!creds) {
    return {
      status: 'no_credentials',
      api_reachable: false,
      has_events: false,
      message: 'No credentials found. Run "opslane setup" first.',
    };
  }

  // Check API health
  let apiReachable = false;
  try {
    const healthResp = await fetchFn(`${creds.api_url}/health`);
    apiReachable = healthResp.ok;
  } catch {
    return {
      status: 'error',
      api_reachable: false,
      has_events: false,
      message: `Cannot reach API at ${creds.api_url}`,
    };
  }

  if (!apiReachable) {
    return {
      status: 'error',
      api_reachable: false,
      has_events: false,
      message: `API at ${creds.api_url} returned unhealthy status`,
    };
  }

  // Check if events have been received (server returns {has_events: bool}).
  // This is a session-authenticated read, so an auth failure means verify
  // failed; it is not equivalent to a healthy project with zero events.
  let countResp: Response;
  try {
    countResp = await authedFetch(
      `${creds.api_url}/api/v1/projects/${creds.project_id}/event-count`,
      {
        apiUrl: creds.api_url,
        fetchFn,
        tokenPath: options.tokenPath,
        loadToken: options.loadToken,
      },
    );
  } catch (err) {
    return {
      status: 'error',
      api_reachable: true,
      has_events: false,
      message: (err as Error).message,
    };
  }
  if (!countResp.ok) {
    const body = await countResp.json().catch(() => ({})) as Record<string, unknown>;
    return {
      status: 'error',
      api_reachable: true,
      has_events: false,
      message: typeof body['error'] === 'string'
        ? body['error']
        : `Session verification failed with status ${countResp.status}`,
    };
  }
  const body = await countResp.json() as Record<string, unknown>;
  const hasEvents = body['has_events'] === true;

  return {
    status: 'ok',
    api_reachable: true,
    has_events: hasEvents,
    message: hasEvents
      ? 'Connected. Events received.'
      : 'Connected. Waiting for first event.',
  };
}

export async function verify(options: VerifyOptions = {}): Promise<void> {
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return exitWithStatus('usage_error', { message: '--api-url must be a valid http(s) URL' }, 1);
  }
  const result = await verifyConnection({ ...options, apiUrl });
  if (result.status === 'no_credentials') {
    return exitWithStatus('no_credentials', { message: 'Run "opslane setup" in this repo first.' }, 1);
  }
  jsonOutput(result);
  if (result.status === 'error') {
    process.exit(1);
  }
}
