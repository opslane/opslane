/**
 * Render every onboarding screen without an API key, a repository, or an agent.
 *
 *   pnpm --filter @opslane/cli exec tsx scripts/tui-playground.tsx
 *
 * This renders the REAL `Tui` from the same fixtures the tests assert on
 * (`src/onboard/__tests__/fixtures.ts`). It replaced a hand-drawn mock: once
 * the screens existed, a second hand-written copy of them could only drift, and
 * a playground showing a screen nobody ships is worse than no playground.
 *
 * It exists because these screens were otherwise unreachable without paying for
 * a live Detect run — which is how the consent screen shipped showing a
 * 130-character absolute path and no diff.
 */
import { render } from 'ink-testing-library';
import React from 'react';

import { plan, preview } from '../src/onboard/__tests__/fixtures.js';
import type { ActionPreview } from '../src/onboard/preview.js';
import { Tui } from '../src/onboard/tui.js';

const ask = (question: string) => ({ question, options: ['Yes', 'No'], multi: false });

const tasks = [
  { id: '1', label: 'Read package.json', state: 'done' as const },
  { id: '2', label: 'Read vite.config.ts', state: 'done' as const },
  { id: '3', label: 'Read src/main.tsx', state: 'run' as const },
];

/** An already-wired repository: nothing to edit, and no install required. */
const noOp: ActionPreview = { ...preview, editsCode: false, installCommand: null };

const SCREENS: Array<[string, React.ComponentProps<typeof Tui>]> = [
  ['Looking at the repository', { stage: 'detect', tasks }],
  ['Consent — normal', {
    stage: 'apply',
    tasks: [],
    plan,
    preview,
    dirty: ['src/App.tsx', 'README.md', 'notes.md'],
    approving: true,
    question: ask('Apply this?'),
  }],
  ['Consent — clean tree', {
    stage: 'apply', tasks: [], plan, preview, dirty: [], approving: true,
    question: ask('Apply this?'),
  }],
  ['Consent — already set up', {
    stage: 'apply', tasks: [], plan, preview: noOp, dirty: [], approving: true,
    question: ask('Everything is already set up. Start your dev server?'),
  }],
  ['Installing', { stage: 'installing', tasks: [], preview, output: 'added 271 packages' }],
  ['Waiting for the first report', { stage: 'waiting', tasks: [], preview, url: 'http://localhost:5173/' }],
  ['Done', { stage: 'done', tasks: [], preview, url: 'http://localhost:5173/' }],
  ['Failed', { stage: 'failed', tasks: [], preview, message: 'npm install failed (exit 1).' }],
  ['Aborted', { stage: 'aborted', tasks: [], preview }],
  ['Unsupported', { stage: 'unsupported', tasks: [], message: 'no web app found in this repository' }],
];

for (const [title, props] of SCREENS) {
  const { lastFrame, unmount } = render(<Tui {...props} />);
  console.log(`\n[7m ${title.padEnd(60)} [0m\n`);
  console.log(lastFrame());
  unmount();
}
console.log('');
