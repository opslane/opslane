import { ALL_TRAFFIC } from 'e2b';
import type { SandboxNetworkOpts, SandboxNetworkRule } from 'e2b';

/**
 * Hosts allowed regardless of which git host the project uses.
 *
 * The git host is NOT in this list: it is derived from the clone URL, because
 * `OPSLANE_GITHUB_URL` makes it configurable (self-hosted git, and the local
 * verify rigs). Hard-coding `github.com` here meant every isolated job on a
 * self-hosted install cloned into a machine whose deny-all policy blocked the
 * only host it needed.
 */
const ALWAYS_ALLOWED_HOSTS = ['registry.npmjs.org', 'api.anthropic.com'] as const;

/**
 * The network policy this module produces.
 *
 * Narrower than `SandboxNetworkOpts` on purpose: that type allows a callback
 * for `allowOut`/`denyOut` and a `Map` for `rules`, so callers (and tests)
 * could not read the values back without narrowing first.
 */
export interface ReadOnlyNetwork extends SandboxNetworkOpts {
  denyOut: string[];
  allowOut: string[];
  rules: Record<string, SandboxNetworkRule[]>;
}

/**
 * Network policy for a read-only sandbox.
 *
 * The key is attached by E2B's egress proxy, not placed in the sandbox
 * environment. A sandbox holds one customer's repository and untrusted file
 * content steers the model, so a key inside the machine is reachable by the very
 * thing being isolated. Measured: a request from inside with no key returns 200,
 * and `env` inside the machine contains no Anthropic variable.
 *
 * E2B returns 400 unless denyOut names ALL_TRAFFIC, so the deny is not redundant.
 */
export function buildReadOnlyNetwork(anthropicApiKey: string, repoUrl: string): ReadOnlyNetwork {
  if (!anthropicApiKey) throw new Error('Anthropic API key is required to build the egress rule');
  let gitHost: string;
  try {
    gitHost = new URL(repoUrl).hostname;
  } catch {
    throw new Error('A clone URL is required to build the egress policy');
  }
  if (!gitHost) throw new Error('A clone URL is required to build the egress policy');
  return {
    denyOut: [ALL_TRAFFIC],
    // Deduplicated: a repoUrl already naming an always-allowed host would
    // otherwise appear twice in the policy.
    allowOut: [...new Set([gitHost, ...ALWAYS_ALLOWED_HOSTS])],
    rules: {
      'api.anthropic.com': [
        { transform: { headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' } } },
      ],
    },
  };
}
