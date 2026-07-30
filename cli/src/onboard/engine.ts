import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  query,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { EditTracker } from './events.js';
import {
  createOnboardApproval,
  onboardPreToolUseHook,
  type ApprovalRequest,
} from './policy.js';
import { containedRepoRelative } from './paths.js';
import { createSearchTool } from './search-tool.js';
import {
  restoreSnapshot,
  snapshotRegularFile,
  type FileSnapshot,
} from './snapshot.js';
import { renderApplySpec, renderDetectSpec } from './spec.js';
import {
  createAskUserTool,
  createFinishApplyTool,
  createOnboardServer,
  createReportPlanTool,
  OPSLANE_SDK_VERSION,
  packageManagerForRepo,
  type AskUserResolver,
  type FinishApplyReport,
  type OnboardingPlan,
} from './tools.js';
import { verifyAlreadyOnboarded, verifyApplied } from './verify.js';

const SHADOW_WARNING = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
const INTENTIONALLY_SHADOWED_TOOLS = new Set([
  'mcp__onboard__report_plan',
  'mcp__onboard__ask_user',
]);
const REPORT_PLAN_TOOL = 'mcp__onboard__report_plan';
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export type QueryFn = (request: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface EngineResult {
  ok: boolean;
  aborted: boolean;
  subtype?: string;
  reason?: string;
  /** The agent's own explanation, when `reason === 'unsupported'`. */
  unsupportedReason?: string;
}

export interface ApplyReport extends FinishApplyReport {
  installRequired: boolean;
  installCommand?: string;
  installCwd: string;
}

export interface ApplyResult extends EngineResult {
  editedFiles?: string[];
  installRequired?: boolean;
  installCommand?: string;
  installCwd?: string;
  failures?: string[];
  restoreFailures?: string[];
}

export function detectOptions({
  cwd,
  hook,
  mcpServers,
  abortController,
}: {
  cwd: string;
  hook: HookCallback;
  mcpServers: Record<string, McpServerConfig>;
  abortController: AbortController;
}): Options {
  return {
    cwd,
    permissionMode: 'default',
    settingSources: [],
    strictMcpConfig: true,
    allowedTools: ['mcp__onboard__report_plan', 'mcp__onboard__ask_user'],
    tools: ['Read', 'Glob'],
    disallowedTools: [
      'Grep',
      'Write',
      'Edit',
      'MultiEdit',
      'Bash',
      'WebFetch',
      'WebSearch',
    ],
    mcpServers,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool: async (toolName) => {
      // `search` is a bounded, secret-aware local MCP tool. It deliberately
      // remains outside allowedTools so the SDK still consults this fail-closed gate.
      if (toolName === 'Read' || toolName === 'Glob' || toolName === 'mcp__onboard__search') {
        return { behavior: 'allow' };
      }
      return {
        behavior: 'deny',
        message: `Detect stage does not allow tool ${toolName}`,
      };
    },
    abortController,
    maxTurns: 50,
  };
}

export function applyOptions({
  cwd,
  hook,
  mcpServers,
  canUseTool,
  abortController,
}: {
  cwd: string;
  hook: HookCallback;
  mcpServers: Record<string, McpServerConfig>;
  canUseTool: NonNullable<Options['canUseTool']>;
  abortController: AbortController;
}): Options {
  return {
    cwd,
    permissionMode: 'default',
    settingSources: [],
    strictMcpConfig: true,
    allowedTools: [],
    tools: ['Read', 'Edit', 'Write'],
    disallowedTools: [
      'Grep',
      'Glob',
      'MultiEdit',
      'Bash',
      'WebFetch',
      'WebSearch',
    ],
    mcpServers,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool,
    abortController,
    maxTurns: 30,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warningCode(warning: Error): string | undefined {
  const code = (warning as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isShadowWarning(warning: Error): boolean {
  return (
    warningCode(warning) === SHADOW_WARNING ||
    warning.name.includes(SHADOW_WARNING) ||
    warning.message.includes(SHADOW_WARNING)
  );
}

function isIntentionalShadowWarning(warning: Error): boolean {
  const match = /canUseTool will not be invoked for: ([^.]+)\./.exec(warning.message);
  if (match === null) return false;
  const shadowedTools = match[1]!.split(',').map((toolName) => toolName.trim());
  return (
    shadowedTools.length > 0 &&
    shadowedTools.every((toolName) => INTENTIONALLY_SHADOWED_TOOLS.has(toolName))
  );
}

function contentBlocks(message: unknown): unknown[] {
  if (!isRecord(message) || !isRecord(message.message) || !Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content;
}

interface ReportStreamState {
  toolUseIds: Set<string>;
  settledToolUseIds: Set<string>;
  successfulResults: number;
  acceptedResultSeen: boolean;
  attemptedAfterSuccess: boolean;
}

function updateReportStream(message: unknown, state: ReportStreamState): void {
  for (const block of contentBlocks(message)) {
    if (
      isRecord(block) &&
      block.type === 'tool_use' &&
      block.name === REPORT_PLAN_TOOL &&
      typeof block.id === 'string'
    ) {
      if (state.acceptedResultSeen) state.attemptedAfterSuccess = true;
      state.toolUseIds.add(block.id);
      continue;
    }
    if (
      isRecord(block) &&
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      state.toolUseIds.has(block.tool_use_id) &&
      !state.settledToolUseIds.has(block.tool_use_id)
    ) {
      state.settledToolUseIds.add(block.tool_use_id);
      if (block.is_error === true) {
        if (state.acceptedResultSeen) state.attemptedAfterSuccess = true;
      } else {
        state.successfulResults += 1;
        state.acceptedResultSeen = true;
      }
    }
  }
}

export async function runAgentCore({
  prompt,
  options,
  onMessage,
  signal,
  queryFn,
}: {
  prompt: string;
  options: (abortController: AbortController) => Options;
  onMessage: (message: SDKMessage) => void;
  signal: AbortSignal;
  queryFn: QueryFn;
}): Promise<EngineResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, aborted: false, reason: 'no_api_key' };
  }
  if (signal.aborted) {
    return { ok: false, aborted: true, reason: 'aborted' };
  }

  const abortController = new AbortController();
  const abortFromCaller = () => abortController.abort();
  signal.addEventListener('abort', abortFromCaller, { once: true });

  let shadowError: Error | undefined;
  const onWarning = (warning: Error) => {
    if (!isShadowWarning(warning) || isIntentionalShadowWarning(warning)) return;
    shadowError = new Error(`Agent SDK permission callback was shadowed: ${warning.message}`);
    abortController.abort();
  };
  process.on('warning', onWarning);

  let terminalSubtype: string | undefined;
  let caughtError: Error | undefined;
  try {
    const messages = queryFn({ prompt, options: options(abortController) });
    for await (const message of messages) {
      onMessage(message);
      if (isRecord(message) && message.type === 'result' && typeof message.subtype === 'string') {
        terminalSubtype = message.subtype;
      }
    }
  } catch (error) {
    caughtError = error instanceof Error ? error : new Error(String(error));
  } finally {
    process.off('warning', onWarning);
    signal.removeEventListener('abort', abortFromCaller);
  }

  if (shadowError !== undefined) {
    return { ok: false, aborted: false, reason: shadowError.message };
  }
  if (signal.aborted || abortController.signal.aborted) {
    return { ok: false, aborted: true, subtype: terminalSubtype, reason: 'aborted' };
  }
  if (caughtError !== undefined) {
    return { ok: false, aborted: false, subtype: terminalSubtype, reason: caughtError.message };
  }
  if (terminalSubtype === undefined) {
    return { ok: false, aborted: false, reason: 'missing_result' };
  }
  if (terminalSubtype !== 'success') {
    return { ok: false, aborted: false, subtype: terminalSubtype, reason: terminalSubtype };
  }
  return { ok: true, aborted: false, subtype: terminalSubtype };
}

export async function runDetect({
  cwd,
  onMessage,
  onPlan,
  signal,
  askUser = null,
  queryFn = (request) => query(request),
}: {
  cwd: string;
  onMessage: (message: SDKMessage) => void;
  onPlan: (plan: OnboardingPlan) => void;
  signal: AbortSignal;
  askUser?: AskUserResolver | null;
  queryFn?: QueryFn;
}): Promise<EngineResult> {
  let planCaptures = 0;
  let reportCaptures = 0;
  let unsupportedReason: string | undefined;
  const capturePlan = (plan: OnboardingPlan) => {
    planCaptures += 1;
    reportCaptures += 1;
    onPlan(plan);
  };
  const captureUnsupported = (reason: string) => {
    reportCaptures += 1;
    unsupportedReason = reason;
  };

  const hook = onboardPreToolUseHook({ root: cwd });
  const mcpServers = {
    onboard: createOnboardServer(
      createReportPlanTool(cwd, capturePlan, captureUnsupported),
      createAskUserTool(askUser),
      createSearchTool(cwd),
    ),
  };
  const reportStream: ReportStreamState = {
    toolUseIds: new Set<string>(),
    settledToolUseIds: new Set<string>(),
    successfulResults: 0,
    acceptedResultSeen: false,
    attemptedAfterSuccess: false,
  };
  const core = await runAgentCore({
    prompt: renderDetectSpec({ cwd }),
    options: (abortController) => detectOptions({ cwd, hook, mcpServers, abortController }),
    onMessage: (message) => {
      onMessage(message);
      updateReportStream(message, reportStream);
    },
    signal,
    queryFn,
  });
  if (!core.ok) return core;
  if (
    reportCaptures > 1 ||
    planCaptures > 1 ||
    reportStream.successfulResults > 1 ||
    reportStream.attemptedAfterSuccess
  ) {
    return { ...core, ok: false, reason: 'multiple_plans' };
  }
  if (unsupportedReason !== undefined) {
    return { ...core, ok: false, reason: 'unsupported', unsupportedReason };
  }
  if (reportCaptures === 0 || planCaptures === 0) {
    return { ...core, ok: false, reason: 'no_plan' };
  }
  return core;
}

function hash(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function occurrenceOffset(contents: string, needle: string, occurrence: number): number {
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = contents.indexOf(needle, offset);
    if (found === -1) return -1;
    if (index === occurrence) return found;
    offset = found + needle.length;
  }
  return -1;
}

function anchorIsWholeLine(contents: string, anchor: string, occurrence: number): boolean {
  if (anchor.includes('\n') || anchor.includes('\r')) return false;
  const offset = occurrenceOffset(contents, anchor, occurrence);
  if (offset === -1) return false;
  const lineStart = contents.lastIndexOf('\n', offset - 1) + 1;
  const lineEndIndex = contents.indexOf('\n', offset + anchor.length);
  const lineEnd = lineEndIndex === -1 ? contents.length : lineEndIndex;
  return (
    /^[\t ]*$/.test(contents.slice(lineStart, offset)) &&
    /^[\t ]*\r?$/.test(contents.slice(offset + anchor.length, lineEnd))
  );
}

function sameSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && Array.from(a).every((value) => b.has(value));
}

function installCommand(packageManager: OnboardingPlan['package_manager']): string {
  return `${packageManager} install`;
}

function isStrictlyUnder(directory: string, file: string): boolean {
  if (directory === '.') return file !== '.';
  const relative = path.posix.relative(directory, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('../') &&
    !path.posix.isAbsolute(relative)
  );
}

export async function runApply({
  cwd,
  plan,
  onMessage,
  onReport,
  requestApproval,
  signal,
  queryFn = (request) => query(request),
}: {
  cwd: string;
  plan: OnboardingPlan;
  onMessage: (message: SDKMessage) => void;
  onReport: (report: ApplyReport) => void;
  requestApproval: ApprovalRequest;
  signal: AbortSignal;
  queryFn?: QueryFn;
}): Promise<ApplyResult> {
  if (
    plan.dependency.name !== '@opslane/sdk' ||
    plan.dependency.version !== OPSLANE_SDK_VERSION
  ) {
    return { ok: false, aborted: false, reason: 'invalid_dependency' };
  }
  if (!PACKAGE_MANAGERS.has(plan.package_manager)) {
    return { ok: false, aborted: false, reason: 'invalid_package_manager' };
  }
  let entry: FileSnapshot;
  let manifest: FileSnapshot;
  try {
    const appDir = containedRepoRelative(cwd, plan.app_dir) || '.';
    if (appDir !== plan.app_dir) {
      return { ok: false, aborted: false, reason: 'invalid_app_dir' };
    }
    const detectedPackageManager = packageManagerForRepo(cwd, appDir);
    if (
      detectedPackageManager !== null &&
      detectedPackageManager !== plan.package_manager
    ) {
      return { ok: false, aborted: false, reason: 'invalid_package_manager' };
    }
    entry = snapshotRegularFile(cwd, plan.edit.file, MAX_ENTRY_BYTES);
    manifest = snapshotRegularFile(cwd, plan.edit.manifest_file, MAX_MANIFEST_BYTES);
    if (
      path.posix.basename(manifest.relative) !== 'package.json' ||
      !isStrictlyUnder(appDir, entry.relative) ||
      !isStrictlyUnder(appDir, manifest.relative) ||
      entry.relative === manifest.relative
    ) {
      return { ok: false, aborted: false, reason: 'invalid_manifest' };
    }
    JSON.parse(manifest.contents.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      aborted: false,
      reason: `invalid_plan: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (hash(entry.contents) !== plan.edit.entry_hash) {
    return { ok: false, aborted: false, reason: 'stale_plan' };
  }
  if (hash(manifest.contents) !== plan.edit.manifest_hash) {
    return { ok: false, aborted: false, reason: 'stale_manifest' };
  }
  if (
    !new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']).has(
      path.extname(entry.relative).toLowerCase(),
    )
  ) {
    return { ok: false, aborted: false, reason: 'unsupported_entry_extension' };
  }
  if (
    !anchorIsWholeLine(
      entry.contents.toString('utf8'),
      plan.edit.anchor,
      plan.edit.occurrence,
    )
  ) {
    return { ok: false, aborted: false, reason: 'anchor_moved' };
  }
  if (plan.existing_sdk.action === 'migrate') {
    return { ok: false, aborted: false, reason: 'migrate_unsupported' };
  }

  const installCwd = plan.app_dir;
  if (plan.existing_sdk.action === 'no_op') {
    const verified = verifyAlreadyOnboarded({ root: cwd, plan });
    if (!verified.ok) {
      return {
        ok: false,
        aborted: false,
        reason: 'invalid_no_op',
        failures: verified.failures,
      };
    }
    const report: ApplyReport = {
      editedFiles: [],
      summary: 'Opslane was already wired into this application.',
      installRequired: false,
      installCwd,
    };
    try {
      onReport(report);
    } catch (error) {
      return {
        ok: false,
        aborted: false,
        reason: `report_callback_failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      ok: true,
      aborted: false,
      subtype: 'already_onboarded',
      editedFiles: [],
      installRequired: false,
      installCwd,
    };
  }

  const rollback = (result: ApplyResult): ApplyResult => {
    const restoreFailures = [restoreSnapshot(entry), restoreSnapshot(manifest)].filter(
      (failure): failure is string => failure !== undefined,
    );
    return restoreFailures.length === 0
      ? result
      : {
          ok: false,
          aborted: result.aborted,
          subtype: result.subtype,
          reason: 'restore_failed',
          failures: result.failures,
          restoreFailures,
        };
  };

  const state = { finished: false };
  const tracker = new EditTracker(cwd);
  let reportCaptures = 0;
  let capturedReport: FinishApplyReport | undefined;
  const capture = (report: FinishApplyReport) => {
    reportCaptures += 1;
    capturedReport = report;
  };
  const hook = onboardPreToolUseHook({
    root: cwd,
    state,
    writablePaths: [entry.relative, manifest.relative],
  });
  const canUseTool = createOnboardApproval({
    requestApproval,
    allowedTools: ['Read', 'Edit', 'Write', 'mcp__onboard__finish_apply'],
  });
  const mcpServers = {
    onboard: createOnboardServer(
      createFinishApplyTool(cwd, state, capture, () => !tracker.hasUnsettledEdits()),
    ),
  };

  const core = await runAgentCore({
    prompt: renderApplySpec({ cwd, plan }),
    options: (abortController) =>
      applyOptions({ cwd, hook, mcpServers, canUseTool, abortController }),
    onMessage: (message) => {
      onMessage(message);
      tracker.onMessage(message);
    },
    signal,
    queryFn,
  });
  if (!core.ok) return rollback(core);
  if (reportCaptures !== 1 || capturedReport === undefined || !state.finished) {
    return rollback({ ...core, ok: false, reason: 'no_apply_report' });
  }
  if (tracker.hasUnsettledEdits()) {
    return rollback({ ...core, ok: false, reason: 'unsettled_edits' });
  }
  if (tracker.editsAfterFinish().length > 0) {
    return rollback({ ...core, ok: false, reason: 'edits_after_finish' });
  }

  const expectedFiles = [entry.relative, manifest.relative];
  const committedFiles = tracker.committedBeforeFinish();
  if (
    !sameSet(capturedReport.editedFiles, committedFiles) ||
    !sameSet(capturedReport.editedFiles, expectedFiles)
  ) {
    return rollback({ ...core, ok: false, reason: 'edit_reconciliation_failed' });
  }

  const verification = verifyApplied({
    root: cwd,
    plan,
    editedFiles: capturedReport.editedFiles,
    originals: { entry: entry.contents, manifest: manifest.contents },
  });
  if (!verification.ok) {
    return rollback({
      ...core,
      ok: false,
      reason: 'verification_failed',
      failures: verification.failures,
    });
  }

  const command = installCommand(plan.package_manager);
  const report: ApplyReport = {
    ...capturedReport,
    installRequired: true,
    installCommand: command,
    installCwd,
  };
  try {
    onReport(report);
  } catch (error) {
    return rollback({
      ...core,
      ok: false,
      reason: `report_callback_failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return {
    ...core,
    editedFiles: capturedReport.editedFiles,
    installRequired: true,
    installCommand: command,
    installCwd,
  };
}
