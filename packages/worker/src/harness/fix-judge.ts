import { withRunLog } from '../run-logs/handle.js';
import { loggedMessagesCreate, messageRequestDto, messagesClient } from '../run-logs/logged-messages.js';
import type { RunContext } from '../run-logs/context.js';
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { Diagnosis } from '@opslane/shared';
import { calculateCost } from '@opslane/agent-core';
import type { LedgerEntry, TierRecord } from '../verification-ledger.js';
import { fenced } from '../prompt-fence.js';
import { pricingFor } from './agent-loop.js';
import type { SandboxRuntime } from './sandbox-runtime.js';

export const FIX_JUDGE_MODEL = process.env['FIX_JUDGE_MODEL'] ?? 'claude-sonnet-5';
export const JUDGE_PROBE_BUDGET = 3;

export interface FixJudgeInput {
  runContext?: RunContext | null;
  apiKey: string;
  diagnosis: Diagnosis | null;
  diff: string;
  testSource: string | null;
  ledger: LedgerEntry[];
  tierRecord: TierRecord;
  anomalies: string[];
  sandbox: SandboxRuntime | null;
  errorTitle: string;
}

export interface FixJudgeVerdict {
  approved: boolean;
  assessment: string;
  vetoReason: string | null;
  sessionId: string;
  probesUsed: number;
  probeCommands: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
}

const VERDICT_TOOL: Anthropic.Tool = {
  name: 'submit_judge_verdict',
  description: 'Submit the final independent assessment. The judge may veto but cannot override failed mechanical predicates.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      approved: { type: 'boolean' },
      assessment: { type: 'string', maxLength: 4000 },
      veto_reason: { type: 'string', maxLength: 600 },
    },
    required: ['approved', 'assessment'],
  },
};

const PROBE_TOOL: Anthropic.Tool = {
  name: 'run_probe',
  description: 'Run one targeted diagnostic command when a mechanical ledger anomaly warrants it.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { command: { type: 'string', maxLength: 1000 } },
    required: ['command'],
  },
};

function failClosed(
  sessionId: string,
  usage: FixJudgeVerdict['usage'],
  probes: string[],
): FixJudgeVerdict {
  return {
    approved: false,
    assessment: 'The judge session did not produce a valid verdict.',
    vetoReason: 'judge_no_verdict: the judge session did not produce a valid verdict',
    sessionId,
    probesUsed: probes.length,
    probeCommands: probes,
    usage,
    costUsd: calculateCost(usage, pricingFor(FIX_JUDGE_MODEL)),
  };
}

function parseVerdict(raw: unknown): Pick<FixJudgeVerdict, 'approved' | 'assessment' | 'vetoReason'> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value['approved'] !== 'boolean') return null;
  if (typeof value['assessment'] !== 'string' || value['assessment'].trim().length === 0) return null;
  const approved = value['approved'];
  const veto = typeof value['veto_reason'] === 'string' ? value['veto_reason'].trim() : '';
  if (!approved && veto.length === 0) return null;
  return {
    approved,
    assessment: value['assessment'].trim().slice(0, 4000),
    vetoReason: approved ? null : veto.slice(0, 600),
  };
}

export interface FixJudgePromptInput {
  diagnosis: Diagnosis | null;
  diff: string;
  testSource: string | null;
  ledger: LedgerEntry[];
  tierRecord: TierRecord;
  anomalies: string[];
  errorTitle: string;
  probeEnabled: boolean;
}

export function buildFixJudgeParams(input: FixJudgePromptInput): Anthropic.MessageCreateParamsNonStreaming {
  const prompt = `You are an independent verification judge. Read the instruments, the candidate diff, and the declared regression test. Approve only when the test is distinctive for the reported bug, fails for the right reason on base, passes with the fix, and the diff is narrowly justified. You can only veto; mechanical predicates are authoritative.

Error title:
<untrusted_data>${fenced(input.errorTitle, 1000)}</untrusted_data>

Diagnosis:
<untrusted_data>${input.diagnosis ? fenced(JSON.stringify(input.diagnosis), 8000) : 'No diagnosis available for this human or legacy attempt.'}</untrusted_data>

Tier record:
<untrusted_data>${fenced(JSON.stringify(input.tierRecord), 3000)}</untrusted_data>

Ledger:
<untrusted_data>${fenced(JSON.stringify(input.ledger), 16000)}</untrusted_data>

Mechanical anomalies:
<untrusted_data>${fenced(JSON.stringify(input.anomalies), 3000)}</untrusted_data>

Declared test source:
<untrusted_data>${fenced(input.testSource ?? 'not available', 30000)}</untrusted_data>

Candidate diff:
<untrusted_data>${fenced(input.diff, 20000)}</untrusted_data>`;
  return {
    model: FIX_JUDGE_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
    tools: [VERDICT_TOOL, ...(input.probeEnabled ? [PROBE_TOOL] : [])],
  };
}

export async function judgeFixAttempt(input: FixJudgeInput): Promise<FixJudgeVerdict> {
  const client = messagesClient(input.apiKey);
  const sessionId = randomUUID();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const probeCommands: string[] = [];
  const promptInput: FixJudgePromptInput = {
    diagnosis: input.diagnosis, diff: input.diff, testSource: input.testSource, ledger: input.ledger,
    tierRecord: input.tierRecord, anomalies: input.anomalies, errorTitle: input.errorTitle,
    probeEnabled: input.anomalies.length > 0 && input.sandbox !== null,
  };
  const first = buildFixJudgeParams(promptInput);
  return withRunLog(
    {
      context: input.runContext ?? null,
      phase: 'judge',
      entryPoint: 'harness/fix-judge#judgeFixAttempt',
      models: [FIX_JUDGE_MODEL],
      settings: { model: FIX_JUDGE_MODEL, maxTokens: 4096, maxTurns: 6, probeBudget: JUDGE_PROBE_BUDGET },
      structuredInput: promptInput,
      request: messageRequestDto(first),
    },
    async (run) => {
      const messages: Anthropic.MessageParam[] = [...first.messages];
      let malformedRetries = 0;
      try {
        for (let turn = 0; turn < 6; turn++) {
          const response = await loggedMessagesCreate(client, run, { ...first, messages }, { logRequest: false });
          usage.input += response.usage?.input_tokens ?? 0;
          usage.output += response.usage?.output_tokens ?? 0;
          usage.cacheRead += response.usage?.cache_read_input_tokens ?? 0;
          usage.cacheWrite += response.usage?.cache_creation_input_tokens ?? 0;
          messages.push({ role: 'assistant', content: response.content });
          const toolCalls = response.content.filter((block) => block.type === 'tool_use');
          const verdictCall = toolCalls.find((block) => block.type === 'tool_use' && block.name === VERDICT_TOOL.name);
          if (verdictCall?.type === 'tool_use') {
            const parsed = parseVerdict(verdictCall.input);
            if (parsed) {
              return { ...parsed, sessionId, probesUsed: probeCommands.length, probeCommands, usage, costUsd: calculateCost(usage, pricingFor(FIX_JUDGE_MODEL)) };
            }
            run.event({ type: 'validator_rejection', message: 'malformed verdict', payload: verdictCall.input });
            if (malformedRetries++ >= 1) return failClosed(sessionId, usage, probeCommands);
            const reask = 'Your verdict was malformed. Submit one valid verdict now; a veto requires a non-empty veto_reason.';
            run.event({ type: 'request', request: { role: 'user', content: reask } });
            messages.push({ role: 'user', content: reask });
            continue;
          }
          const probe = toolCalls.find((block) => block.type === 'tool_use' && block.name === PROBE_TOOL.name);
          if (probe?.type === 'tool_use' && input.sandbox) {
            const command = typeof (probe.input as Record<string, unknown>)['command'] === 'string'
              ? (probe.input as Record<string, unknown>)['command'] as string
              : '';
            run.event({ type: 'tool_call', id: probe.id, name: PROBE_TOOL.name, input: probe.input });
            let output: string;
            if (!command) output = 'Probe refused: command must be a non-empty string.';
            else if (probeCommands.length >= JUDGE_PROBE_BUDGET) {
              output = 'Probe refused: the three-command judge probe budget is exhausted. Submit the verdict now.';
            } else {
              probeCommands.push(command);
              const result = await input.sandbox.commands.run(command);
              output = `${result.stdout}\n${result.stderr}`.slice(-6000);
            }
            run.event({ type: 'tool_result', id: probe.id, name: PROBE_TOOL.name, output, isError: false });
            messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: probe.id, content: output }] });
            continue;
          }
          run.event({ type: 'request', request: { role: 'user', content: 'Submit the verdict using submit_judge_verdict.' } });
          messages.push({ role: 'user', content: 'Submit the verdict using submit_judge_verdict.' });
        }
      } catch (error: unknown) {
        run.event({ type: 'error', errorClass: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error), stack: [] });
        return failClosed(sessionId, usage, probeCommands);
      }
      return failClosed(sessionId, usage, probeCommands);
    },
    (verdict) => (verdict.vetoReason?.startsWith('judge_no_verdict:') ? 'invalid_output' : 'completed'),
  );
}
