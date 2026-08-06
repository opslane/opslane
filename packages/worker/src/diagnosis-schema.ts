import type Anthropic from '@anthropic-ai/sdk';
import type { Diagnosis } from '@opslane/shared';

/** The model reports a diagnosis; it deliberately cannot name an outcome. */
export function submitDiagnosisTool(): Anthropic.Tool {
  return {
    name: 'submit_diagnosis',
    description:
      'Submit your diagnosis. Call this once you can explain what caused the error. ' +
      'Do not propose a fix and do not decide what should happen next.',
    input_schema: {
      type: 'object' as const,
      properties: {
        one_line_description: {
          type: 'string',
          description: 'What caused the error, in under 30 words.',
        },
        why_chain: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered chain of one-line why statements from entry point to failure, each under 15 words.',
        },
        reproduction_steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Steps that would reproduce this error, each under 15 words.',
        },
        cause_location: {
          type: 'string',
          description:
            'Where the cause lives: a repository path with a line number when it is in code, ' +
            'or the named external system. Report where it is; do not decide whether we can fix it.',
        },
      },
      required: ['one_line_description', 'why_chain', 'reproduction_steps', 'cause_location'],
    },
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function clampWords(text: string, maximum: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= maximum ? text.trim() : `${words.slice(0, maximum).join(' ')}…`;
}

/** Return null when the submission cannot support a decision. */
export function parseDiagnosis(raw: Record<string, unknown>): Diagnosis | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const description =
    typeof raw['one_line_description'] === 'string' ? raw['one_line_description'].trim() : '';
  const causeLocation = typeof raw['cause_location'] === 'string' ? raw['cause_location'].trim() : '';
  const whyChain = strings(raw['why_chain']);
  const reproductionSteps = strings(raw['reproduction_steps']);

  if (!description || !causeLocation || whyChain.length === 0 || reproductionSteps.length === 0) {
    return null;
  }

  return {
    one_line_description: clampWords(description, 30),
    why_chain: whyChain.map((entry) => clampWords(entry, 15)),
    reproduction_steps: reproductionSteps.map((entry) => clampWords(entry, 15)),
    cause_location: causeLocation,
  };
}
