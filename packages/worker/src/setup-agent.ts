import type { ConfidenceLevel, NeedsHumanReason } from '@opslane/shared';
import type { AgentState } from './harness/types.js';
import type { ToolDefinition } from './harness/types.js';
import { runAgentLoop } from './harness/agent-loop.js';
import { createToolBridge } from './harness/tool-bridge.js';
import { createDefaultMiddleware } from './harness/tool-middleware.js';
import { createRepoSandbox, extractDiff, runBuildGate } from './harness/sandbox-repo.js';
import { logger } from './logger.js';
import { cloneFailureReason } from './repo-clone.js';

export interface SetupPromptInput {
  apiKeyEnvVar: string;
  releaseEnvVar: string;
}

export function buildSetupSystemPrompt(input: SetupPromptInput): string {
  return [
    'You are a senior engineer installing the Opslane error-monitoring SDK into a web app.',
    'The repository is checked out at /home/user/repo (your current working directory).',
    '',
    'Goal: make the minimal, idiomatic change so production frontend errors are captured.',
    '',
    'Steps:',
    '1. Detect the framework (Vue+Vite, React+Vite, or Next.js) from package.json.',
    '2. Install the package "@opslane/sdk" using the repo\'s package manager (npm/pnpm/yarn; match the lockfile).',
    '3. Initialize it in the CLIENT entry point, idiomatic to the framework:',
    '   - import { init } from \'@opslane/sdk\' and call init({ apiKey, release }).',
    '   - Vue: also import { opslaneVuePlugin } and call app.use(opslaneVuePlugin) before app.mount(...).',
    '   - Next.js App Router: put init in a \'use client\' provider component and wrap children in app/layout; never initialize in a Server Component.',
    '4. Read the key and release from environment variables. DO NOT hardcode any values:',
    `   - apiKey: import.meta.env.${input.apiKeyEnvVar} (Vite) or process.env.${input.apiKeyEnvVar} (Next).`,
    `   - release: the matching ${input.releaseEnvVar} variable.`,
    '5. Do NOT add an "environment" field; it is not a valid option and will fail typechecking.',
    '6. Run the build (npm run build / pnpm build, or npx tsc --noEmit) to verify your change compiles. Fix any errors you introduced.',
    '',
    'Keep the change minimal and mergeable. A human will review and merge this PR.',
    'If you cannot complete the install with code changes, call report_setup_blocker with a clear reason and remediation.',
  ].join('\n');
}

export interface AgentSetupInput {
  repoUrl: string;
  githubRepo: string;
  githubToken?: string;
  apiKeyEnvVar: string;
  releaseEnvVar: string;
  abortSignal?: AbortSignal;
  model?: string;
  maxTurns?: number;
  budgetUsd?: number;
}

export type AgentSetupResult =
  | { status: 'setup_ready'; diff: string; confidence: ConfidenceLevel; affectedFiles: string[] }
  | { status: 'needs_human'; reason: NeedsHumanReason };

const SETUP_MODEL = 'claude-sonnet-4-6';
const SETUP_MAX_TURNS = 25;
const SETUP_BUDGET_USD = 1.0;

export async function runAgentSetup(input: AgentSetupInput): Promise<AgentSetupResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return {
      status: 'needs_human',
      reason: {
        reason_code: 'worker_runtime_error',
        reason_message: 'ANTHROPIC_API_KEY not set',
        remediation: 'Configure the worker LLM key',
      },
    };
  }

  let sandboxHandle: Awaited<ReturnType<typeof createRepoSandbox>> | null = null;
  try {
    sandboxHandle = await createRepoSandbox({
      repoUrl: input.repoUrl,
      githubRepo: input.githubRepo,
      githubToken: input.githubToken,
      platform: 'javascript',
    });
  } catch (err: unknown) {
    return {
      status: 'needs_human',
      reason: cloneFailureReason(err),
    };
  }

  const { sandbox } = sandboxHandle;
  try {
    const state: AgentState = {
      turnCount: 0,
      toolCallCount: 0,
      editCounts: new Map(),
      testsRan: true,
      gaveUp: false,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      stackTraceFiles: [],
      scopeReviewDone: false,
      toolHistoryEntries: [],
    };
    const setupBlockerTool: ToolDefinition = {
      name: 'report_setup_blocker',
      description: 'Stop the setup attempt and report why a human must complete it.',
      inputSchema: {
        type: 'object',
        properties: {
          reason_message: { type: 'string' },
          remediation: { type: 'string' },
        },
        required: ['reason_message', 'remediation'],
      },
      execute: async (toolInput) => {
        const reasonMessage = typeof toolInput['reason_message'] === 'string'
          ? toolInput['reason_message'].trim()
          : '';
        const remediation = typeof toolInput['remediation'] === 'string'
          ? toolInput['remediation'].trim()
          : '';
        state.gaveUp = true;
        state.giveUpReason = {
          reason_code: 'worker_runtime_error',
          reason_message: reasonMessage || 'The setup agent could not complete the SDK installation',
          remediation: remediation || 'Install the SDK manually (see docs/install.md)',
        };
        return 'Setup blocker recorded.';
      },
    };
    const tools = [
      ...createToolBridge(sandbox, state).filter((tool) => tool.name !== 'submit_diagnosis'),
      setupBlockerTool,
    ];
    const middleware = createDefaultMiddleware(sandbox);
    const systemPrompt = buildSetupSystemPrompt({
      apiKeyEnvVar: input.apiKeyEnvVar,
      releaseEnvVar: input.releaseEnvVar,
    });

    const result = await runAgentLoop({
      apiKey,
      model: input.model ?? SETUP_MODEL,
      maxTurns: input.maxTurns ?? SETUP_MAX_TURNS,
      budgetUsd: input.budgetUsd ?? SETUP_BUDGET_USD,
      systemPrompt,
      tools,
      middleware,
      externalState: state,
      abortSignal: input.abortSignal,
      onEvent: (e) => {
        if (e.type === 'error') {
          logger.warn('setup agent event error', { code: e.code, message: e.message });
        }
      },
    }, 'Install the Opslane SDK as described in the system prompt. Begin by reading package.json.');

    if (state.gaveUp && state.giveUpReason) {
      return {
        status: 'needs_human',
        reason: {
          reason_code: state.giveUpReason.reason_code as NeedsHumanReason['reason_code'],
          reason_message: state.giveUpReason.reason_message,
          remediation: state.giveUpReason.remediation,
        },
      };
    }

    if (!result.success) {
      return {
        status: 'needs_human',
        reason: {
          reason_code: 'budget_exhausted',
          reason_message: result.summary || 'Agent could not complete the install',
          remediation: 'Install the SDK manually (see docs/install.md)',
        },
      };
    }

    const gate = await runBuildGate(sandbox);
    const buildAccepted = gate.outcome === 'passed' || gate.outcome === 'skipped_no_runner';
    if (!buildAccepted) {
      return {
        status: 'needs_human',
        reason: {
          reason_code: 'tests_failed',
          reason_message: `Generated setup did not build:\n${gate.output}`,
          remediation: 'Install the SDK manually (see docs/install.md); the automated edit did not compile',
        },
      };
    }

    const { diff, affectedFiles } = await extractDiff(sandbox);
    if (diff.trim().length === 0) {
      return {
        status: 'needs_human',
        reason: {
          reason_code: 'malformed_diff',
          reason_message: 'Agent produced no changes',
          remediation: 'Install the SDK manually (see docs/install.md)',
        },
      };
    }

    const confidence: ConfidenceLevel = gate.outcome === 'skipped_no_runner' ? 'medium' : 'high';
    return { status: 'setup_ready', diff, confidence, affectedFiles };
  } finally {
    await sandbox.kill().catch(() => {});
  }
}
