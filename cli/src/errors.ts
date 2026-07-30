import { resolveCredentials, defaultCredentialsPath } from './agent-credentials.js';
import { jsonOutput, exitWithError, exitWithStatus } from './output.js';
import { defaultApiUrl } from './config.js';
import { detectRepoFromGit } from './setup.js';
import { canonicalOrigin } from './origin.js';
import { authedFetch, type SessionTokenLoader } from './authed-fetch.js';

export interface ErrorsOptions {
  status?: string;
  limit?: number;
  credentialsPath?: string;
  fetchFn?: typeof fetch;
  apiUrl?: string;
  repo?: string;
  cwd?: string;
  tokenPath?: string;
  loadToken?: SessionTokenLoader;
}

async function fetchAndOutput(
  fetchFn: typeof fetch,
  apiUrl: string,
  url: string,
  options: Pick<ErrorsOptions, 'tokenPath' | 'loadToken'>,
): Promise<void> {
  try {
    const resp = await authedFetch(url, {
      apiUrl,
      fetchFn,
      tokenPath: options.tokenPath,
      loadToken: options.loadToken,
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
      return exitWithStatus('error', {
        status: resp.status,
        code: body['code'] ?? null,
        message: body['error'] ?? `API error: ${resp.status}`,
      }, 1);
    }

    const body = await resp.json();
    jsonOutput(body as Record<string, unknown>);
  } catch (err) {
    return exitWithError((err as Error).message);
  }
}

export async function listErrors(options: ErrorsOptions = {}): Promise<void> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const fetchFn = options.fetchFn ?? fetch;
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return exitWithStatus('usage_error', { message: '--api-url must be a valid http(s) URL' }, 1);
  }

  const creds = await resolveCredentials({
    filePath: credPath,
    apiUrl,
    repo: options.repo ?? detectRepoFromGit(options.cwd),
  });
  if (!creds) {
    return exitWithStatus('no_credentials', { message: 'Run "opslane setup" in this repo first.' }, 1);
  }

  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', String(options.limit));

  const url = `${creds.api_url}/api/v1/projects/${creds.project_id}/incidents?${params}`;
  await fetchAndOutput(fetchFn, creds.api_url, url, options);
}

export async function getError(errorId: string, options: ErrorsOptions = {}): Promise<void> {
  const credPath = options.credentialsPath ?? defaultCredentialsPath();
  const fetchFn = options.fetchFn ?? fetch;
  let apiUrl: string;
  try {
    apiUrl = canonicalOrigin(options.apiUrl ?? defaultApiUrl());
  } catch {
    return exitWithStatus('usage_error', { message: '--api-url must be a valid http(s) URL' }, 1);
  }

  const creds = await resolveCredentials({
    filePath: credPath,
    apiUrl,
    repo: options.repo ?? detectRepoFromGit(options.cwd),
  });
  if (!creds) {
    return exitWithStatus('no_credentials', { message: 'Run "opslane setup" in this repo first.' }, 1);
  }

  const url = `${creds.api_url}/api/v1/projects/${creds.project_id}/incidents/${encodeURIComponent(errorId)}`;
  await fetchAndOutput(fetchFn, creds.api_url, url, options);
}
