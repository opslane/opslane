import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Stage } from '../core.js';
import type { ActionPreview } from '../preview.js';
import { Tui } from '../tui.js';
import { plan, preview } from './fixtures.js';
import type { OnboardingPlan } from '../tools.js';

afterEach(() => {
  cleanup();
});



describe('onboarding TUI', () => {
  it('renders the question and resolves on Enter', async () => {
    const onAnswer = vi.fn();
    const { lastFrame, stdin } = render(
      <Tui
        stage="detect"
        tasks={[]}
        onAnswer={onAnswer}
        question={{ question: 'Which app?', options: ['web', 'admin'], multi: false }}
      />,
    );
    expect(lastFrame()).toContain('Which app?');
    stdin.write('\r');
    // Select reports through a React effect, so it lands a tick after the key.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onAnswer).toHaveBeenCalledWith(['web']);
  });

  it.each([
    ['unsupported', 'this repository has no web application', /no web application/],
    [
      'failed',
      'manifest does not contain an identity-capable Opslane SDK version',
      /identity-capable/,
    ],
    ['aborted', undefined, /cancell?ed|stopped/i],
  ])('renders %s so the user can act', (stage, message, pattern) => {
    const frame =
      render(<Tui stage={stage as Stage} tasks={[]} message={message} />).lastFrame() ?? '';
    expect(frame).toMatch(pattern);
    expect(frame).not.toMatch(/⠋|⠙|⠹/); // no spinner on a terminal state
  });

  it('shows the clickable URL while waiting', () => {
    expect(
      render(<Tui stage="waiting" tasks={[]} url="http://localhost:5173/" />).lastFrame(),
    ).toContain('http://localhost:5173/');
  });

  it('renders dropped successes and failures separately', () => {
    const tasks = Array.from({ length: 4 }, (_, index) => ({
      id: `t${index}`,
      label: `Read f${index}.ts`,
      state: 'done' as const,
    }));
    const frame =
      render(<Tui stage="detect" tasks={tasks} droppedDone={33} droppedFailed={3} />)
        .lastFrame() ?? '';
    expect(frame).toMatch(/\b37 done\b/); // 33 dropped + 4 shown
    expect(frame).toMatch(/\b3 failed\b/); // failures must never be counted as done
    expect(frame.split('\n').length).toBeLessThan(15);
  });

  it('renders the checked consent preview without secret values', () => {
    const frame = render(
      <Tui
        stage="awaiting-approval"
        tasks={[]}
        plan={plan}
        preview={preview}
        dirty={['README.md', 'src/App.vue', 'one-more.ts']}
        approving
        question={{ question: 'Apply this?', options: ['Yes', 'No'], multi: false }}
      />,
    ).lastFrame() ?? '';

    for (const expected of [
      'What I found',
      plan.rationale,
      '3 files',
      'README.md, src/App.vue, and 1 more',
      'What I will change',
      'web/src/main.ts',
      'web/package.json',
      '@opslane/sdk ^2.0.0',
      '.env.local',
      '1 new key',
      '1 updated key',
      '.gitignore',
      'pnpm install',
      'pnpm run dev',
      'Apply this?',
    ]) {
      expect(frame).toContain(expected);
    }
    expect(frame).not.toContain('opk_secret');
    expect(frame.indexOf(`+ ${preview.insert.lines[0]}`))
      .toBeLessThan(frame.indexOf(preview.insert.anchor));
  });

  // The SDK only reports from a running browser, so this stage cannot end until
  // a human opens the page. Before this the screen showed the URL with no
  // instruction, which reads as progress rather than as a request, and a user
  // who did not guess would wait for the 15-minute timeout.
  it('asks the user to open the app while waiting for its first report', () => {
    const frame = render(
      <Tui stage="waiting" tasks={[]} url="http://localhost:5173/" />,
    ).lastFrame() ?? '';
    expect(frame).toMatch(/open/i);
    expect(frame).toContain('http://localhost:5173/');
    expect(frame).toMatch(/nothing has reached opslane yet/i);
  });

  it('says why the follow-up commands run, not just what they are', () => {
    const frame = render(
      <Tui
        stage="apply"
        tasks={[]}
        plan={plan}
        preview={preview}
        approving
        question={{ question: 'Apply this?', options: ['Yes', 'No'], multi: false }}
      />,
    ).lastFrame() ?? '';
    // "Then / npm install / npm run dev" read as chores onboarding tacked on.
    // They are how the wiring gets proved, and the heading has to say so.
    expect(frame).toMatch(/to check it actually works/i);
  });

  it('shows only real no-op actions and keeps ordinary confirmations compact', () => {
    const noOpFrame = render(
      <Tui
        stage="awaiting-approval"
        tasks={[]}
        plan={{ ...plan, existing_sdk: { action: 'no_op', name: '@opslane/sdk' } }}
        preview={{ ...preview, gitignoreWillChange: false, installCommand: null, editsCode: false }}
        dirty={[]}
        approving
        question={{ question: 'Apply this?', options: ['Yes', 'No'], multi: false }}
      />,
    ).lastFrame() ?? '';
    expect(noOpFrame).toContain('.env.local');
    expect(noOpFrame).toContain('pnpm run dev');
    expect(noOpFrame).not.toContain('web/src/main.ts');
    expect(noOpFrame).not.toContain('web/package.json');
    expect(noOpFrame).not.toContain('.gitignore');
    expect(noOpFrame).not.toContain('pnpm install');

    cleanup();
    const confirmFrame = render(
      <Tui
        stage="apply"
        tasks={[]}
        plan={plan}
        preview={preview}
        question={{ question: 'Allow Edit src/main.ts?', options: ['Yes', 'No'], multi: false }}
      />,
    ).lastFrame() ?? '';
    expect(confirmFrame).toContain('Allow Edit src/main.ts?');
    expect(confirmFrame).not.toContain('What I will change');
  });
});
