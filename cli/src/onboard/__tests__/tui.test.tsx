import { cleanup, render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Stage } from '../core.js';
import { Tui } from '../tui.js';

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
});
