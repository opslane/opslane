import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOnboardApproval, onboardPreToolUseHook } from '../policy.js';

const denied = (output: unknown) =>
  (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === 'deny';
const run = (
  hook: ReturnType<typeof onboardPreToolUseHook>,
  name: string,
  input: Record<string, unknown>,
) =>
  hook(
    { tool_name: name, tool_input: input, tool_use_id: 't' } as never,
    undefined,
    { signal: new AbortController().signal },
  );

describe('onboarding hard-denial hook', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opslane-policy-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), '');
    symlinkSync('/etc', join(root, 'link'));
  });

  const hook = (state?: { finished: boolean }) => onboardPreToolUseHook({ root, state });

  it('denies path escapes on every file tool', async () => {
    for (const name of ['Read', 'Glob', 'Edit', 'Write', 'MultiEdit']) {
      expect(denied(await run(hook(), name, { file_path: '/etc/passwd' }))).toBe(true);
      expect(denied(await run(hook(), name, { file_path: join(root, '..', 'out') }))).toBe(true);
      expect(denied(await run(hook(), name, { file_path: join(root, 'link', 'x') }))).toBe(true);
    }
    expect(denied(await run(hook(), 'Read', { file_path: join(root, 'src', 'main.ts') }))).toBe(
      false,
    );
  });

  it('denies every dotenv-shaped path', async () => {
    expect(denied(await run(hook(), 'Read', { file_path: join(root, '.env.production') }))).toBe(
      true,
    );
    expect(denied(await run(hook(), 'Glob', { pattern: '**/.envrc' }))).toBe(true);
  });

  it('denies credential files and directories beyond dotenv', async () => {
    for (const candidate of [
      '.git/config',
      '.npmrc',
      '.netrc',
      '.git-credentials',
      '.ssh/id_rsa',
      '.aws/credentials',
      'certs/server.pem',
      'deploy/prod.tfvars',
    ]) {
      expect(
        denied(await run(hook(), 'Read', { file_path: join(root, ...candidate.split('/')) })),
        candidate,
      ).toBe(true);
    }
    expect(denied(await run(hook(), 'Read', { file_path: join(root, 'src', 'main.ts') }))).toBe(
      false,
    );
  });

  it('denies Bash outright: the agent has no shell', async () => {
    for (const command of ['pnpm run build', 'pnpm run lint', 'npm install', 'echo hi']) {
      expect(denied(await run(hook(), 'Bash', { command }))).toBe(true);
    }
  });

  it('denies every post-finish tool except ask_user', async () => {
    const finished = hook({ finished: true });
    expect(denied(await run(finished, 'Edit', { file_path: join(root, 'a.ts') }))).toBe(true);
    expect(denied(await run(finished, 'mcp__onboard__ask_user', {}))).toBe(false);
  });

  it('restricts mutations to the exact canonical writable paths while retaining safe reads', async () => {
    writeFileSync(join(root, 'package.json'), '{}\n');
    writeFileSync(join(root, 'src', 'other.ts'), '');
    const restricted = onboardPreToolUseHook({
      root,
      writablePaths: ['src/main.ts', 'package.json'],
    });

    expect(
      denied(await run(restricted, 'Edit', { file_path: join(root, 'src', '..', 'src', 'main.ts') })),
    ).toBe(false);
    expect(denied(await run(restricted, 'Write', { file_path: join(root, 'package.json') }))).toBe(
      false,
    );
    expect(denied(await run(restricted, 'Edit', { file_path: join(root, 'src', 'other.ts') }))).toBe(
      true,
    );
    expect(denied(await run(restricted, 'Read', { file_path: join(root, 'src', 'other.ts') }))).toBe(
      false,
    );
  });
});

describe('onboarding approval callback', () => {
  it('requests approval for mutations without changing finish state', async () => {
    const approved = createOnboardApproval({ requestApproval: async () => true });
    const declined = createOnboardApproval({ requestApproval: async () => false });

    await expect(
      approved('Edit', { file_path: '/r/a' }, {} as never),
    ).resolves.toMatchObject({ behavior: 'allow' });
    await expect(
      declined('Edit', { file_path: '/r/b' }, {} as never),
    ).resolves.toEqual({ behavior: 'deny', message: 'declined' });
    // Bash is not in the default allow-set at all, so it never reaches approval.
    await expect(
      approved('Bash', { command: 'pnpm run build' }, {} as never),
    ).resolves.toEqual({ behavior: 'deny', message: 'Onboarding does not allow tool Bash' });
  });

  it('allows read-only tools without prompting', async () => {
    let calls = 0;
    const approval = createOnboardApproval({
      requestApproval: async () => {
        calls += 1;
        return false;
      },
    });

    await expect(approval('Read', { file_path: '/r/a' }, {} as never)).resolves.toMatchObject({
      behavior: 'allow',
    });
    expect(calls).toBe(0);
  });

  it('fails closed for tools outside the stage allowlist', async () => {
    const approval = createOnboardApproval({
      requestApproval: async () => true,
      allowedTools: ['Read', 'Edit'],
    });

    await expect(approval('WebFetch', {}, {} as never)).resolves.toMatchObject({
      behavior: 'deny',
    });
  });

  it('forwards the SDK options to requestApproval', async () => {
    const seen: unknown[] = [];
    const canUseTool = createOnboardApproval({
      requestApproval: async (_toolName, _input, options) => {
        seen.push(options);
        return true;
      },
    });
    const options = { signal: new AbortController().signal };

    await canUseTool('Edit', { file_path: 'a.ts' }, options as never);

    expect(seen[0]).toBe(options);
  });

  it('denies rather than hangs when the approval is aborted', async () => {
    const controller = new AbortController();
    const canUseTool = createOnboardApproval({
      requestApproval: () => new Promise<boolean>(() => undefined),
    });
    const pending = canUseTool(
      'Edit',
      { file_path: 'a.ts' },
      { signal: controller.signal } as never,
    );

    controller.abort();

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('denies immediately when the signal is already aborted', async () => {
    const requestApproval = vi.fn(() => new Promise<boolean>(() => undefined));
    const canUseTool = createOnboardApproval({ requestApproval });

    await expect(
      canUseTool(
        'Edit',
        { file_path: 'a.ts' },
        { signal: AbortSignal.abort() } as never,
      ),
    ).resolves.toMatchObject({ behavior: 'deny' });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('removes its abort listener when approval wins the race', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const canUseTool = createOnboardApproval({ requestApproval: async () => true });

    for (let index = 0; index < 50; index += 1) {
      await canUseTool(
        'Edit',
        { file_path: 'a.ts' },
        { signal: controller.signal } as never,
      );
    }

    expect(add).toHaveBeenCalledTimes(50);
    expect(remove).toHaveBeenCalledTimes(50);
    expect(() => controller.abort()).not.toThrow();
  });
});
