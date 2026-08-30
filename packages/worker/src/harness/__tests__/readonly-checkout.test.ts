import { describe, expect, it, vi } from 'vitest';

/**
 * `createReadOnlyCheckout` rents a real machine, so the provider is stubbed.
 * Everything else — the command sequence, the order the git facts are read in,
 * and what is handed back — is the real implementation.
 */
const created = vi.hoisted(() => ({ calls: [] as string[], opts: null as unknown }));

const sandbox = vi.hoisted(() => ({
  sandboxId: 'sbx-test',
  isRunning: async (): Promise<boolean> => true,
  files: { write: async (): Promise<void> => undefined },
  kill: async (): Promise<undefined> => undefined,
  commands: {
    run: async (cmd: string): Promise<{ stdout: string }> => {
      created.calls.push(cmd);
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        // What git actually prints once `git checkout <sha>` has detached HEAD.
        return { stdout: created.calls.some((c) => c.includes('git checkout')) ? 'HEAD\n' : 'main\n' };
      }
      if (cmd.includes('rev-parse HEAD')) return { stdout: 'a'.repeat(40) + '\n' };
      if (cmd.includes('ls-files')) return { stdout: 'src/a.ts\n' };
      return { stdout: '' };
    },
  },
}));

vi.mock('e2b', async (importOriginal) => ({
  ...(await importOriginal<typeof import('e2b')>()),
  Sandbox: {
    create: async (opts: unknown): Promise<typeof sandbox> => {
      created.opts = opts;
      return sandbox;
    },
  },
}));

const { createReadOnlyCheckout } = await import('../readonly-sandbox.js');

const BASE = {
  repoUrl: 'https://github.com/acme/app.git',
  githubToken: 'ghs-test',
  anthropicApiKey: 'sk-ant-test',
};

describe('createReadOnlyCheckout default branch', () => {
  it('reports the branch the clone was on, not the detached "HEAD" after a commit checkout', async () => {
    // `git checkout <sha>` detaches HEAD, and `git rev-parse --abbrev-ref HEAD`
    // then prints the literal string "HEAD". Reading the branch after the
    // checkout persisted that into projects.default_branch, overwriting the real
    // branch on every investigation that carried a commit SHA.
    created.calls.length = 0;
    const checkout = await createReadOnlyCheckout({ ...BASE, commitSha: 'b'.repeat(40) });
    expect(checkout.defaultBranch).toBe('main');
    const branchRead = created.calls.findIndex((c) => c.includes('rev-parse --abbrev-ref HEAD'));
    const checkedOut = created.calls.findIndex((c) => c.includes('git checkout'));
    expect(branchRead).toBeGreaterThan(-1);
    expect(branchRead).toBeLessThan(checkedOut);
    await checkout.close();
  });

  it('ignores a commit that is not a plain SHA rather than passing it to git', async () => {
    // `q()` stops shell injection but not git argument injection: git consumes a
    // value starting with `-` as a flag, and this runs while the clone
    // credential is still in the machine.
    created.calls.length = 0;
    const checkout = await createReadOnlyCheckout({ ...BASE, commitSha: '--upload-pack=touch /tmp/pwned' });
    expect(created.calls.some((c) => c.includes('git checkout'))).toBe(false);
    expect(checkout.defaultBranch).toBe('main');
    await checkout.close();
  });

  it('allows the project\'s own git host out of a deny-all machine', async () => {
    created.calls.length = 0;
    const checkout = await createReadOnlyCheckout({ ...BASE, repoUrl: 'https://git.acme.dev/acme/app.git' });
    expect((created.opts as { network: { allowOut: string[] } }).network.allowOut).toContain('git.acme.dev');
    await checkout.close();
  });

  it('removes the clone credential before handing back a reader', async () => {
    created.calls.length = 0;
    const checkout = await createReadOnlyCheckout(BASE);
    const removed = created.calls.findIndex((c) => c.includes('.netrc') && c.includes('rm -f'));
    const factRead = created.calls.findIndex((c) => c.includes('ls-files'));
    expect(removed).toBeGreaterThan(-1);
    expect(removed).toBeLessThan(factRead);
    await checkout.close();
  });
});
