import { defaultTokenPath } from './auth.js';
import { ensureLoggedIn } from './onboard/provision.js';

export type SessionTokenLoader = () => Promise<{ accessToken: string } | null>;

export interface AuthedFetchOptions {
  apiUrl: string;
  fetchFn?: typeof fetch;
  tokenPath?: string;
  loadToken?: SessionTokenLoader;
  /** Defaults to GET. Present so callers can POST through the same refresh path
   * rather than hand-rolling an authenticated request. */
  method?: string;
  body?: string;
}

/**
 * Fetch a CLI read endpoint with the user's session.
 *
 * The default loader refreshes expired sessions, but never opens an
 * interactive login flow for a read command.
 */
export async function authedFetch(
  url: string,
  options: AuthedFetchOptions,
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const loadToken = options.loadToken
    ?? (() => ensureLoggedIn({
      apiUrl: options.apiUrl,
      tokenPath: options.tokenPath ?? defaultTokenPath(),
      fetchFn,
      loginFn: async () => {
        throw new Error('Not signed in. Run "opslane login" first.');
      },
    }));

  const token = await loadToken();
  if (!token) {
    throw new Error('Not signed in. Run "opslane login" first.');
  }

  return fetchFn(url, {
    method: options.method,
    body: options.body,
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
}
