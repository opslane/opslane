/**
 * The onboarding view. Pure: every value it renders arrives as a prop and every
 * decision it makes is about presentation. No effects, no timers of its own, and
 * no knowledge of the controller beyond `CoreEvent`'s shape.
 */
import { MultiSelect, Select, Spinner } from '@inkjs/ui';
import { Box, Text } from 'ink';
import React from 'react';

import type { Stage } from './core.js';
import type { TaskLine } from './events.js';
import type { ActionPreview } from './preview.js';
import type { OnboardingPlan } from './tools.js';

export interface TuiProps {
  stage: Stage;
  tasks: TaskLine[];
  droppedDone?: number;
  droppedFailed?: number;
  question?: { question: string; options: string[]; multi: boolean };
  plan?: OnboardingPlan;
  preview?: ActionPreview;
  dirty?: string[] | null;
  approving?: boolean;
  url?: string;
  output?: string;
  message?: string;
  onAnswer?: (answer: string[]) => void;
}

const TERMINAL_STAGES = new Set<Stage>(['done', 'failed', 'unsupported', 'aborted']);

const HEADLINE: Record<Stage, string> = {
  login: 'Signing you in',
  provision: 'Setting up your Opslane project',
  detect: 'Looking at your repository',
  'awaiting-approval': 'Reviewing the plan',
  apply: 'Wiring the Opslane SDK into your app',
  'writing-env': 'Writing .env.local',
  installing: 'Installing dependencies',
  'starting-dev': 'Starting your dev server',
  waiting: 'Waiting for your app to report',
  done: 'Your app is connected to Opslane.',
  failed: 'Onboarding stopped.',
  unsupported: 'Onboarding cannot handle this repository.',
  aborted: 'Cancelled. Nothing was left running.',
};

const ICON: Record<TaskLine['state'], string> = { run: '·', done: '✓', fail: '✗' };

function Tasks({
  tasks,
  droppedDone = 0,
  droppedFailed = 0,
}: Pick<TuiProps, 'tasks' | 'droppedDone' | 'droppedFailed'>): React.JSX.Element | null {
  const done = droppedDone + tasks.filter((task) => task.state === 'done').length;
  const failed = droppedFailed + tasks.filter((task) => task.state === 'fail').length;
  if (done === 0 && failed === 0 && tasks.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{`✓ ${done} done`}</Text>
        {failed > 0 ? <Text color="red">{`  ✗ ${failed} failed`}</Text> : null}
      </Box>
      {tasks.map((task) => (
        <Text key={task.id} color={task.state === 'fail' ? 'red' : undefined}>
          {`${ICON[task.state]} ${task.label}`}
        </Text>
      ))}
    </Box>
  );
}

function Question({
  question,
  onAnswer,
}: Required<Pick<TuiProps, 'question'>> & Pick<TuiProps, 'onAnswer'>): React.JSX.Element {
  const options = question.options.map((option) => ({ label: option, value: option }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{question.question}</Text>
      {question.multi ? (
        <MultiSelect options={options} onSubmit={(values) => onAnswer?.(values)} />
      ) : (
        <Select options={options} onChange={(value) => onAnswer?.([value])} />
      )}
    </Box>
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function dirtySummary(files: string[]): string {
  const shown = files.slice(0, 2);
  return files.length <= 2
    ? shown.join(', ')
    : `${shown.join(', ')}, and ${files.length - shown.length} more`;
}

function dependencyLabel(dependency: string): string {
  const separator = dependency.lastIndexOf('@');
  return separator <= 0
    ? dependency
    : `${dependency.slice(0, separator)} ${dependency.slice(separator + 1)}`;
}

function shortPath(value: string, width = 46): string {
  if (value.length <= width) return value;
  const parts = value.split('/');
  let suffix = parts.pop() ?? value;
  while (parts.length > 0) {
    const next = `${parts.at(-1)}/${suffix}`;
    if (next.length + 2 > width) break;
    suffix = next;
    parts.pop();
  }
  return `…/${suffix}`;
}

/**
 * `width` is the widest path in this particular list, not a constant. A fixed
 * column left "src/main.tsx" trailing 36 spaces before its description, which
 * reads as a layout bug rather than a table.
 */
function ActionLine({
  file,
  action,
  width,
}: { file: string; action: string; width: number }): React.JSX.Element {
  return <Text>{`  ${shortPath(file).padEnd(width + 2)}${action}`}</Text>;
}

function envSummary(preview: ActionPreview): string {
  const changes = [
    preview.envKeysAdded.length > 0
      ? plural(preview.envKeysAdded.length, 'new key')
      : '',
    preview.envKeysReplaced.length > 0
      ? plural(preview.envKeysReplaced.length, 'updated key')
      : '',
  ].filter(Boolean);
  return changes.join(', ') || 'keys already current';
}

function InsertPreview({ insert }: Pick<ActionPreview, 'insert'>): React.JSX.Element {
  const anchor = <Text key="anchor">{`    ${insert.anchor}`}</Text>;
  const additions = insert.lines.map((line, index) => (
    <Text key={`insert-${index}`} color="green">{`  + ${line}`}</Text>
  ));
  return (
    <Box flexDirection="column" marginTop={1}>
      {insert.position === 'before' ? [...additions, anchor] : [anchor, ...additions]}
    </Box>
  );
}

/**
 * The end of a successful run.
 *
 * Deliberately does NOT print the dev-server URL. core.ts stops the server in a
 * `finally` before this event is emitted, so by the time the line is on screen
 * the address is dead — printing it invites the user to click a link that will
 * not load and conclude onboarding failed. Say the server was stopped and give
 * the command to start it again instead.
 */
function Done({ preview }: Pick<TuiProps, 'preview'>): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>{'✓ Opslane is connected.'}</Text>
      <Box marginTop={1}>
        <Text dimColor>
          {'Your app reported in, so errors from it will reach Opslane from now on.'}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text>{'I stopped the dev server I started. To run your app again:'}</Text>
        <Text color="cyan">{`  ${preview?.devCommand ?? 'your usual dev command'}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {'Next time this app throws in production, Opslane investigates it and\n'
            + 'opens a pull request with a fix.'}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Waiting for the app's first report.
 *
 * The SDK only reports from a running browser, so this stage cannot end until a
 * human opens the page. Nothing said so: the screen showed "Waiting for your app
 * to report" over a bare URL, which reads as progress rather than as a request.
 * A user who did not guess would watch a spinner until the 15-minute timeout.
 */
function Waiting({ url }: Pick<TuiProps, 'url'>): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text color="green">{'✓ Your dev server is running.'}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>{'Open your app so it can report in:'}</Text>
        <Text color="cyan">{`  ${url ?? 'your dev server URL'}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {'Nothing has reached Opslane yet. I am watching for the first report,\n'
            + 'and will finish as soon as it arrives.'}
        </Text>
      </Box>
    </Box>
  );
}

function Consent({
  plan,
  preview,
  dirty,
  question,
  onAnswer,
}: Required<Pick<TuiProps, 'plan' | 'preview' | 'question'>>
  & Pick<TuiProps, 'dirty' | 'onAnswer'>): React.JSX.Element {
  const changesCode = preview.editsCode;
  const gitignoreFile = preview.envFile.replace(/\.env\.local$/, '.gitignore');
  const addedLines = preview.insert.lines.length;
  const column = Math.max(
    ...[
      ...(changesCode ? [preview.entryFile, preview.manifestFile] : []),
      preview.envFile,
      ...(preview.gitignoreWillChange ? [gitignoreFile] : []),
    ].map((file) => shortPath(file).length),
  );

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">◆</Text>
        <Text bold>{' opslane'}</Text>
        <Text dimColor>{'  onboarding'}</Text>
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>What I found</Text>
        <Box marginLeft={2}>
          <Text dimColor>{plan.rationale}</Text>
        </Box>
      </Box>

      {dirty !== null && dirty !== undefined && dirty.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">
            {`⚠ ${plural(dirty.length, 'file')} already ${
              dirty.length === 1 ? 'has' : 'have'
            } uncommitted changes; mine will be mixed in with them.`}
          </Text>
          <Box marginLeft={2}>
            <Text dimColor>{dirtySummary(dirty)}</Text>
          </Box>
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text bold>What I will change</Text>
          <Text color="green">{'  ✓ all checked on disk'}</Text>
        </Text>
        {changesCode ? (
          <>
            <ActionLine file={preview.entryFile} action={`add ${plural(addedLines, 'line')}`} width={column} />
            <ActionLine
              file={preview.manifestFile}
              action={`+ ${dependencyLabel(preview.addedDependency)}`}
              width={column}
            />
          </>
        ) : null}
        <ActionLine file={preview.envFile} action={envSummary(preview)} width={column} />
        {preview.gitignoreWillChange
          ? <ActionLine file={gitignoreFile} action="+ .env.local" width={column} />
          : null}
      </Box>

      {/*
        Commands are a separate list from files. Cramming "then start npm run dev
        in ." onto the end of a file list read as a fourth file, and the working
        directory is only worth saying when it is not the repository root — "in ."
        is noise to anyone who is not us.
      */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Then, to check it actually works</Text>
        {preview.installCommand !== null
          ? <Text>{`  ${preview.installCommand}`}</Text>
          : null}
        <Text>
          {`  ${preview.devCommand}`}
          {preview.devCwd === '.' ? '' : `   in ${preview.devCwd}`}
        </Text>
      </Box>

      {changesCode ? <InsertPreview insert={preview.insert} /> : null}
      <Question question={question} onAnswer={onAnswer} />
    </Box>
  );
}

export function Tui({
  stage,
  tasks,
  droppedDone,
  droppedFailed,
  question,
  plan,
  preview,
  dirty,
  approving,
  url,
  output,
  message,
  onAnswer,
}: TuiProps): React.JSX.Element {
  if (approving === true && plan !== undefined && preview !== undefined && question !== undefined) {
    return (
      <Consent
        plan={plan}
        preview={preview}
        dirty={dirty}
        question={question}
        onAnswer={onAnswer}
      />
    );
  }

  if (stage === 'done') return <Done preview={preview} />;
  if (stage === 'waiting') return <Waiting url={url} />;

  const terminal = TERMINAL_STAGES.has(stage);
  return (
    <Box flexDirection="column">
      {terminal ? (
        <Text color={stage === 'aborted' ? 'yellow' : 'red'}>{HEADLINE[stage]}</Text>
      ) : (
        <Spinner label={HEADLINE[stage]} />
      )}
      {message ? <Text>{message}</Text> : null}
      {url ? <Text color="cyan">{url}</Text> : null}
      <Tasks tasks={tasks} droppedDone={droppedDone} droppedFailed={droppedFailed} />
      {output ? <Text dimColor>{output}</Text> : null}
      {question ? <Question question={question} onAnswer={onAnswer} /> : null}
    </Box>
  );
}
