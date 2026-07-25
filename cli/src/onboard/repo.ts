import { detectRepoFromGit, normalizeRepoURL } from '../setup.js';

export type ResolvedRepo =
  | { ok: true; repo: string }
  | { ok: false; message: string };

export function resolveRepo({
  repo,
  detect = detectRepoFromGit,
}: {
  repo?: string;
  detect?: () => string | null;
}): ResolvedRepo {
  if (repo !== undefined) {
    const normalized = normalizeRepoURL(repo);
    return normalized === null
      ? {
          ok: false,
          message: `--repo must be owner/repo or a GitHub URL, got ${JSON.stringify(repo)}`,
        }
      : { ok: true, repo: normalized };
  }

  const detected = detect();
  return detected === null
    ? {
        ok: false,
        message:
          'Could not determine the repository from git. Pass --repo <owner/repo>, or add a '
          + 'GitHub remote with: git remote add origin git@github.com:owner/repo.git',
      }
    : { ok: true, repo: detected };
}
