import {
  type CanUseTool,
  type HookCallback,
  type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { containedRepoRelative, hasSecretSegment } from './paths.js';

const FILE_TOOLS = new Set(['Read', 'Glob', 'Edit', 'Write', 'MultiEdit']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);
const PATH_KEYS = new Set(['path', 'file_path', 'pattern']);

function deny(reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
}

function pathValues(value: unknown, key?: string): string[] {
  if (typeof value === 'string') return key !== undefined && PATH_KEYS.has(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => pathValues(item, key));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([childKey, child]) => pathValues(child, childKey));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function onboardPreToolUseHook({
  root,
  state,
  writablePaths,
}: {
  root: string;
  state?: { finished: boolean };
  writablePaths?: Iterable<string>;
}): HookCallback {
  const canonicalWritable =
    writablePaths === undefined
      ? undefined
      : new Set(Array.from(writablePaths, (candidate) => containedRepoRelative(root, candidate)));
  return async (input) => {
    const preToolInput = input as PreToolUseHookInput;
    const toolName = preToolInput.tool_name;
    const toolInput = asRecord(preToolInput.tool_input);

    if (state?.finished === true) {
      return toolName === 'mcp__onboard__ask_user'
        ? {}
        : deny('Onboarding has already finished');
    }

    if (FILE_TOOLS.has(toolName)) {
      const paths = pathValues(toolInput);
      if (paths.length === 0) return deny(`${toolName} did not provide a path`);
      for (const candidate of paths) {
        let relative: string;
        try {
          relative = containedRepoRelative(root, candidate);
        } catch {
          return deny(`${toolName} path is not contained in the repository`);
        }
        if (hasSecretSegment(relative)) return deny(`${toolName} cannot access secret files`);
        if (
          canonicalWritable !== undefined &&
          EDIT_TOOLS.has(toolName) &&
          !canonicalWritable.has(relative)
        ) {
          return deny(`${toolName} is not allowed to modify ${relative}`);
        }
      }
    }

    if (toolName === 'Bash') {
      // The agent has no shell. Both stages also list Bash in disallowedTools
      // and runApply passes a Bash-free allow-set, so this is defence in depth.
      // docs/decisions/agent-runs-commands.md records why a shell was rejected.
      return deny('The onboarding agent is not allowed to run shell commands');
    }

    return {};
  };
}

export type ApprovalRequest = (
  toolName: string,
  input: Record<string, unknown>,
  options?: { signal?: AbortSignal; [key: string]: unknown },
) => Promise<boolean>;

export function createOnboardApproval({
  requestApproval,
  allowedTools = [
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'mcp__onboard__finish_apply',
    'mcp__onboard__ask_user',
  ],
}: {
  requestApproval: ApprovalRequest;
  allowedTools?: Iterable<string>;
}): CanUseTool {
  const allowed = new Set(allowedTools);
  return async (toolName, input, options) => {
    if (!allowed.has(toolName)) {
      return { behavior: 'deny', message: `Onboarding does not allow tool ${toolName}` };
    }
    if (!MUTATING_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };

    const signal = options?.signal;
    if (signal?.aborted === true) return { behavior: 'deny', message: 'declined' };

    let onAbort: (() => void) | undefined;
    try {
      const approved = await new Promise<boolean>((resolve) => {
        onAbort = () => resolve(false);
        signal?.addEventListener('abort', onAbort, { once: true });
        void requestApproval(toolName, input, options).then(resolve, () => resolve(false));
      });
      return approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'declined' };
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    }
  };
}
