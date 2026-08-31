import { ALL_TRAFFIC } from 'e2b';
import type { SandboxNetworkOpts, SandboxNetworkRule } from 'e2b';
import type { Platform } from '../platform.js';

/**
 * Hosts allowed regardless of which git host the project uses.
 *
 * The git host is NOT in this list: it is derived from the clone URL, because
 * `OPSLANE_GITHUB_URL` makes it configurable (self-hosted git, and the local
 * verify rigs). Hard-coding `github.com` here meant every isolated job on a
 * self-hosted install cloned into a machine whose deny-all policy blocked the
 * only host it needed.
 */
const ALWAYS_ALLOWED_HOSTS = ['registry.npmjs.org'] as const;

/** GitHub serves clones, raw files and release binaries from different hosts. */
const GITHUB_HOSTS = [
  'github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const;

const FIX_HOSTS: Record<Platform, readonly string[]> = {
  javascript: ['registry.npmjs.org', 'nodejs.org', ...GITHUB_HOSTS],
  python: ['pypi.org', 'files.pythonhosted.org', ...GITHUB_HOSTS],
};

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
 * The model loop and its credential remain on the worker. The machine needs
 * only its repository host and the package registry; Anthropic is deliberately
 * absent from both the allowlist and the proxy rules.
 *
 * E2B returns 400 unless denyOut names ALL_TRAFFIC, so the deny is not redundant.
 */
export function buildReadOnlyNetwork(repoUrl: string): ReadOnlyNetwork {
  let gitHost: string;
  try {
    gitHost = new URL(repoUrl).hostname;
  } catch {
    // A URL we cannot parse is one whose host we cannot allow. Refuse rather
    // than build a policy that silently blocks the clone.
    throw new Error('A clone URL is required to build the egress policy');
  }
  return {
    denyOut: [ALL_TRAFFIC],
    // A `file://` remote has no host and needs no egress at all: the local
    // verify rigs clone a twin repository off the filesystem. Allowing nothing
    // extra is the correct policy there, not an error.
    //
    // Deduplicated, because a repoUrl already naming an always-allowed host
    // would otherwise appear twice in the policy.
    allowOut: [...new Set([...(gitHost ? [gitHost] : []), ...ALWAYS_ALLOWED_HOSTS])],
    rules: {},
  };
}

/** Egress needed to clone and install dependencies in a credential-free fix machine. */
export function buildFixNetwork(platform: Platform): ReadOnlyNetwork {
  return {
    denyOut: [ALL_TRAFFIC],
    allowOut: [...FIX_HOSTS[platform]],
    rules: {},
  };
}
