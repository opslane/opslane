import { ALL_TRAFFIC } from 'e2b';
import type { SandboxNetworkOpts, SandboxNetworkRule } from 'e2b';

const ALLOWED_HOSTS = ['registry.npmjs.org', 'github.com', 'api.anthropic.com'] as const;

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
export function buildReadOnlyNetwork(anthropicApiKey: string): ReadOnlyNetwork {
  if (!anthropicApiKey) throw new Error('Anthropic API key is required to build the egress rule');
  return {
    denyOut: [ALL_TRAFFIC],
    allowOut: [...ALLOWED_HOSTS],
    rules: {
      'api.anthropic.com': [
        { transform: { headers: { 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' } } },
      ],
    },
  };
}
