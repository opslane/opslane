import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ROOT = '/tmp/opslane-gheval-repos';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * Clone a repository at exactly one commit, with no other history reachable.
 *
 * The previous clone used --filter=blob:none --no-checkout and then checked out
 * base_sha, which fetches EVERY ref. The merged fix was therefore reachable:
 * for documenso#2945 one `git log --all --grep="typed signature"` returned the
 * fix commit, so any arm with a shell could read the answer it was scored on.
 *
 * The single-commit fetch is what carries the guarantee. The fixSha assertion is
 * a spot check that it held, not a proof of it.
 */
export function cloneAtBase(repoUrl, baseSha, fixSha, root = DEFAULT_ROOT) {
  // Both SHAs land in a directory name that is later rmSync'd recursively, and
  // as positional git arguments. `base_sha: '../../../../'` would delete the
  // filesystem root; `--upload-pack=...` would be parsed as a git option.
  // Neither field is validated anywhere upstream, so validate here.
  for (const [name, value] of [['base_sha', baseSha], ['fix_sha', fixSha]]) {
    if (!/^[0-9a-f]{40}$/.test(String(value ?? ''))) {
      throw new Error(`${name} must be a full 40-character hex object id, got ${JSON.stringify(value)}`);
    }
  }

  const slug = repoUrl.replace(/[^\w.-]+/g, '__');
  const dir = join(root, `${slug}-${baseSha.slice(0, 12)}`);
  const marker = `${dir}.single-commit`;

  // Trust a cache only if this function built it AND the worktree is still what
  // it built: right HEAD, one commit, no local modifications. Anything else is
  // rebuilt, because a mutated worktree contaminates every later arm and repeat.
  let reusable = false;
  if (existsSync(dir) && existsSync(marker)) {
    try {
      reusable =
        readFileSync(marker, 'utf8').trim() === baseSha &&
        git(dir, 'rev-parse', 'HEAD') === baseSha &&
        git(dir, 'rev-list', '--all', '--count') === '1' &&
        git(dir, 'status', '--porcelain') === '';
    } catch { reusable = false; }
  }

  if (!reusable) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(marker, { force: true });
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    execFileSync('git', ['-C', dir, 'fetch', '-q', '--depth', '1', repoUrl, baseSha], { stdio: 'pipe' });
    git(dir, 'checkout', '-q', 'FETCH_HEAD');
    writeFileSync(marker, `${baseSha}\n`);
  }

  let reachable = false;
  try {
    git(dir, 'cat-file', '-e', `${fixSha}^{commit}`);
    reachable = true;
  } catch { /* expected: the fix must not be resolvable */ }
  if (reachable) throw new Error(`Ground-truth leak: ${fixSha} is resolvable from the clone at ${dir}`);

  return dir;
}
