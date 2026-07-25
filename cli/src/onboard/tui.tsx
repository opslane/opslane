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

export interface TuiProps {
  stage: Stage;
  tasks: TaskLine[];
  droppedDone?: number;
  droppedFailed?: number;
  question?: { question: string; options: string[]; multi: boolean };
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

export function Tui({
  stage,
  tasks,
  droppedDone,
  droppedFailed,
  question,
  url,
  output,
  message,
  onAnswer,
}: TuiProps): React.JSX.Element {
  const terminal = TERMINAL_STAGES.has(stage);
  return (
    <Box flexDirection="column">
      {terminal ? (
        <Text color={stage === 'done' ? 'green' : stage === 'aborted' ? 'yellow' : 'red'}>
          {HEADLINE[stage]}
        </Text>
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
