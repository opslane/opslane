import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { createOnboardShell, OnboardApp, runOnboardApp } from '../app.js';
import type { CoreDeps, CoreResult } from '../core.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ink renders and flushes effects on its own schedule, so a fixed sleep is a
 * flake waiting to happen. Poll the condition instead.
 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A frame can be written a tick before the Select's `useInput` effect is live,
 * so a single keystroke can land on nothing. Repeat until the prompt clears.
 */
async function pressEnter(
  stdin: { write: (data: string) => void },
  done: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (done()) return;
    stdin.write('\r');
    await delay(10);
  }
  throw new Error(`timed out pressing enter for ${label}`);
}

afterEach(() => {
  cleanup();
});

function shellFor(signal = new AbortController().signal): ReturnType<typeof createOnboardShell> {
  return createOnboardShell({ signal });
}

describe('onboarding Ink shell', () => {
  it('resolves an approval to true when accepted', async () => {
    const shell = shellFor();
    const { lastFrame, stdin } = render(<OnboardApp shell={shell} />);
    let resolved: boolean | undefined;
    void shell.ui.requestApproval('Edit', { file_path: 'src/main.ts' }).then((value) => {
      resolved = value;
    });
    await waitFor(() => /src\/main\.ts/.test(lastFrame() ?? ''), 'the approval prompt');
    await pressEnter(stdin, () => resolved !== undefined, 'the approval');
    expect(resolved).toBe(true);
  });

  it('prefers the SDK-supplied title over a reconstructed sentence', async () => {
    const shell = shellFor();
    const { lastFrame } = render(<OnboardApp shell={shell} />);
    void shell.ui.requestApproval('Edit', { file_path: 'a.ts' }, {
      title: 'Claude wants to edit a.ts',
    } as never);
    await waitFor(
      () => (lastFrame() ?? '').includes('Claude wants to edit a.ts'),
      'the SDK-supplied title',
    );
    expect(lastFrame()).toContain('Claude wants to edit a.ts');
  });

  it('queues overlapping approvals instead of dropping one', async () => {
    const shell = shellFor();
    const { lastFrame, stdin } = render(<OnboardApp shell={shell} />);
    const settled: boolean[] = [];
    const a = shell.ui
      .requestApproval('Edit', { file_path: 'a.ts' })
      .then((value) => settled.push(value));
    const b = shell.ui
      .requestApproval('Edit', { file_path: 'b.ts' })
      .then((value) => settled.push(value));
    await waitFor(() => (lastFrame() ?? '').includes('a.ts'), 'the first approval');
    await pressEnter(stdin, () => settled.length >= 1, 'the first approval');
    await waitFor(() => (lastFrame() ?? '').includes('b.ts'), 'the second approval');
    await pressEnter(stdin, () => settled.length >= 2, 'the second approval');
    await Promise.all([a, b]);
    expect(settled).toHaveLength(2);
  });

  it('settles a queued question with an empty answer, not false', async () => {
    const controller = new AbortController();
    const shell = shellFor(controller.signal);
    render(<OnboardApp shell={shell} />);
    let answer: string[] | undefined;
    void shell.ui
      .askUser({ question: 'Which app?', options: ['web'], multi: false })
      .then((value) => {
        answer = value;
      });
    await waitFor(() => shell.getPrompt() !== undefined, 'the question to be queued');
    controller.abort();
    await waitFor(() => answer !== undefined, 'the question to settle');
    expect(answer).toEqual([]); // string[], not `false`
  });

  it('settles every pending prompt when the signal aborts', async () => {
    const controller = new AbortController();
    const shell = shellFor(controller.signal);
    render(<OnboardApp shell={shell} />);
    let resolved: boolean | undefined;
    void shell.ui.requestApproval('Edit', { file_path: 'a.ts' }).then((value) => {
      resolved = value;
    });
    await waitFor(() => shell.getPrompt() !== undefined, 'the approval to be queued');
    controller.abort();
    await waitFor(() => resolved !== undefined, 'the approval to settle');
    expect(resolved).toBe(false); // denied, not left hanging
  });

  it('runOnboardApp builds real deps, logs in through the shell, and returns the core result', async () => {
    const calls: string[] = [];
    const result = await runOnboardApp({
      cwd: '/repo',
      repo: 'acme/web',
      apiUrl: 'http://localhost:8082',
      signal: new AbortController().signal,
      logDir: mkdtempSync(join(tmpdir(), 'opslane-app-log-')),
      // test seam: swap the core so we assert the DEPS it received, not the flow
      runCore: async (d: CoreDeps): Promise<CoreResult> => {
        calls.push(
          typeof d.loginFn,
          typeof d.runLog.record,
          typeof d.writeEnv,
          d.tokenPath ? 'tokenPath' : 'none',
        );
        return { ok: true, status: 'completed' };
      },
    });
    expect(result).toMatchObject({ ok: true, status: 'completed' });
    expect(calls).toEqual(['function', 'function', 'function', 'tokenPath']);
  });
});
