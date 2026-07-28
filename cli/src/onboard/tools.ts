import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { containedRepoRelative, hasSecretSegment } from './paths.js';
import {
  OPSLANE_IDENTITY_MIN_VERSION,
  validatePlannedWiring,
} from './verify.js';

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
/** First release that includes the required SDK identity and Vite 8 support. */
export const OPSLANE_SDK_VERSION = `^${OPSLANE_IDENTITY_MIN_VERSION}`;
/**
 * What Apply should do about an error/monitoring SDK already in the repo.
 *
 *   none    - no error SDK found at all. Apply proceeds normally. (the common case)
 *   keep    - another SDK is present; install Opslane alongside it. `name` is that SDK.
 *   migrate - replace the named SDK with Opslane. `name` is that SDK.
 *   no_op   - identity-capable @opslane/sdk is already wired; Apply changes nothing.
 *
 * `none` exists because without it the model reached for `no_op` on a repo with no
 * SDK (observed live on directus), which would have told Apply "already onboarded"
 * and silently skipped a repo that needed the work.
 */
const EXISTING_SDK_ACTIONS = ['none', 'keep', 'migrate', 'no_op'] as const;
const EDIT_POSITIONS = ['before', 'after'] as const;
const ENV_VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const OPSLANE_TOKEN = /(?:^|_)OPSLANE(?:_|$)/;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RATIONALE_LENGTH = 600;
const LOCKFILES: Record<string, (typeof PACKAGE_MANAGERS)[number]> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
};

export interface OnboardingPlan {
  app_dir: string;
  framework: string;
  package_manager: (typeof PACKAGE_MANAGERS)[number];
  /** A key of `scripts` in the app's package.json. Verified against disk. */
  dev_script: string;
  env_prefix: string;
  /**
   * Repo-relative directory the bundler loads env files from. NOT always
   * `app_dir`: Vite's `envDir` option moves it, and both monorepos in the eval
   * corpus point it at the repository root while the app lives in a package.
   * The host always writes `.env.local` inside this directory.
   */
  env_dir: string;
  dependency: {
    name: '@opslane/sdk';
    version: string;
  };
  env_vars: {
    api_key: string;
    endpoint: string;
  };
  edit: {
    file: string;
    entry_hash: string;
    manifest_file: string;
    manifest_hash: string;
    /** Apply places this at module top level alongside existing imports. */
    import_line: string;
    /**
     * `anchor`, `position`, and `occurrence` locate this block only. They do
     * not govern placement of `import_line`.
     */
    init_block: string;
    anchor: string;
    position: (typeof EDIT_POSITIONS)[number];
    occurrence: number;
  };
  existing_sdk: {
    action: (typeof EXISTING_SDK_ACTIONS)[number];
    name: string | null;
  };
  rationale: string;
}

/**
 * What the MODEL supplies: the full plan minus host-owned hashes and the SDK
 * version. The model selects the manifest, while the host contains and hashes
 * it and pins the dependency version.
 *
 * The Detect agent has only Read/Glob/search — it cannot compute a sha256, so
 * asking it for one made every report_plan call unsatisfiable (it retried until
 * the turn budget ran out and reported no plan at all). The host stamps the hash
 * from the file it already reads while validating. Exact facts belong to code;
 * judgment belongs to the model.
 */
export type ReportedPlanInput = Omit<OnboardingPlan, 'dependency' | 'edit'> & {
  dependency: { name: '@opslane/sdk' };
  edit: Omit<OnboardingPlan['edit'], 'entry_hash' | 'manifest_hash'>;
};

export type ReportPlanInput =
  | { status: 'ok'; plan: ReportedPlanInput }
  | { status: 'unsupported'; reason: string };

type ServerTool = NonNullable<
  Parameters<typeof createSdkMcpServer>[0]['tools']
>[number];

export type AskUserResolver = (request: {
  question: string;
  options: string[];
  multi: boolean;
}) => Promise<string[]>;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function boundedRationale(value: unknown): string {
  const rationale = nonEmptyString(value, 'rationale');
  if (rationale.length <= MAX_RATIONALE_LENGTH) return rationale;

  const hardLimit = rationale.slice(0, MAX_RATIONALE_LENGTH - 1);
  const whitespace = Math.max(
    hardLimit.lastIndexOf(' '),
    hardLimit.lastIndexOf('\n'),
    hardLimit.lastIndexOf('\t'),
  );
  const body = (whitespace > 0 ? hardLimit.slice(0, whitespace) : hardLimit).trimEnd();
  return `${body}…`;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Unknown ${label}: ${String(value)}`);
  }
  return value as Values[number];
}

function canonicalRepoPath(root: string, value: unknown, label: string): string {
  const candidate = nonEmptyString(value, label);
  const relative = containedRepoRelative(root, candidate) || '.';
  if (hasSecretSegment(relative)) {
    throw new Error(`${label} points to a secret file`);
  }
  return relative;
}

function isUnderDirectory(directory: string, file: string): boolean {
  if (directory === '.') return file !== '.';
  const relative = path.posix.relative(directory, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('../') &&
    !path.posix.isAbsolute(relative)
  );
}

export function packageManagerForRepo(
  root: string,
  appDir: string,
): (typeof PACKAGE_MANAGERS)[number] | null {
  const absoluteRoot = path.resolve(root);
  let directory = path.resolve(absoluteRoot, appDir === '.' ? '' : appDir);
  while (directory === absoluteRoot || directory.startsWith(`${absoluteRoot}${path.sep}`)) {
    const found = new Set(
      Object.entries(LOCKFILES).flatMap(([file, manager]) =>
        existsSync(path.join(directory, file)) ? [manager] : [],
      ),
    );
    if (found.size > 1) {
      throw new Error(`Conflicting package-manager lockfiles in ${path.relative(root, directory) || '.'}`);
    }
    const manager = found.values().next().value;
    if (manager !== undefined) return manager;
    if (directory === absoluteRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

function validateEnvironmentVariable(
  value: unknown,
  envPrefix: string,
  label: string,
): string {
  const variable = nonEmptyString(value, label);
  if (
    !ENV_VARIABLE.test(variable) ||
    !variable.startsWith(envPrefix) ||
    !OPSLANE_TOKEN.test(variable)
  ) {
    throw new Error(
      `${label} must be an uppercase environment variable using prefix ${envPrefix} and containing OPSLANE`,
    );
  }
  return variable;
}

function countOccurrences(contents: string, anchor: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= contents.length - anchor.length) {
    const index = contents.indexOf(anchor, offset);
    if (index === -1) break;
    count += 1;
    offset = index + anchor.length;
  }
  return count;
}

function anchorIsWholeLine(contents: string, anchor: string, occurrence: number): boolean {
  if (anchor.includes('\n') || anchor.includes('\r')) return false;
  let offset = 0;
  let found = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    found = contents.indexOf(anchor, offset);
    if (found === -1) return false;
    offset = found + anchor.length;
  }
  const lineStart = contents.lastIndexOf('\n', found - 1) + 1;
  const lineEndIndex = contents.indexOf('\n', found + anchor.length);
  const lineEnd = lineEndIndex === -1 ? contents.length : lineEndIndex;
  return (
    /^[\t ]*$/.test(contents.slice(lineStart, found)) &&
    /^[\t ]*\r?$/.test(contents.slice(found + anchor.length, lineEnd))
  );
}

function validatePlan(root: string, value: unknown): OnboardingPlan {
  assertRecord(value, 'plan');

  const appDir = canonicalRepoPath(root, value.app_dir, 'app_dir');
  const framework = nonEmptyString(value.framework, 'framework');
  const packageManager = enumValue(value.package_manager, PACKAGE_MANAGERS, 'package manager');
  const detectedPackageManager = packageManagerForRepo(root, appDir);
  if (detectedPackageManager !== null && detectedPackageManager !== packageManager) {
    throw new Error(`package manager must match ${detectedPackageManager} lockfile`);
  }
  const envPrefix = nonEmptyString(value.env_prefix, 'env_prefix');
  const envDir = canonicalRepoPath(root, value.env_dir, 'env_dir');
  if (!existsSync(path.resolve(root, envDir)) || !statSync(path.resolve(root, envDir)).isDirectory()) {
    throw new Error('env_dir must be an existing directory');
  }
  const rationale = boundedRationale(value.rationale);

  assertRecord(value.dependency, 'dependency');
  const dependencyName = nonEmptyString(value.dependency.name, 'dependency.name');
  if (dependencyName !== '@opslane/sdk') {
    throw new Error('dependency.name must be @opslane/sdk');
  }
  assertRecord(value.env_vars, 'env_vars');
  const apiKey = validateEnvironmentVariable(value.env_vars.api_key, envPrefix, 'env_vars.api_key');
  const endpoint = validateEnvironmentVariable(
    value.env_vars.endpoint,
    envPrefix,
    'env_vars.endpoint',
  );

  assertRecord(value.edit, 'edit');
  const editFile = canonicalRepoPath(root, value.edit.file, 'edit.file');
  if (!isUnderDirectory(appDir, editFile)) {
    throw new Error('edit.file must be under app_dir');
  }

  const editAbsolute = path.join(root, editFile);
  let fileContents: Buffer;
  try {
    const metadata = statSync(editAbsolute);
    if (
      lstatSync(editAbsolute).isSymbolicLink() ||
      !metadata.isFile() ||
      // A hard link (nlink > 1) can alias a file OUTSIDE the repo that realpath
      // cannot detect (a hard link has no target path). Refuse it.
      metadata.nlink > 1 ||
      metadata.size > MAX_ENTRY_BYTES
    ) {
      throw new Error('not a regular file');
    }
    fileContents = readFileSync(editAbsolute);
  } catch {
    throw new Error('edit.file must exist and be a regular file');
  }

  // Host-derived, never model-supplied: the agent has no way to compute a
  // sha256. Apply re-hashes this file and refuses a stale plan.
  const entryHash = createHash('sha256').update(fileContents).digest('hex');

  const manifestFile = canonicalRepoPath(root, value.edit.manifest_file, 'edit.manifest_file');
  if (!isUnderDirectory(appDir, manifestFile) || path.posix.basename(manifestFile) !== 'package.json') {
    throw new Error('edit.manifest_file must be a package.json under app_dir');
  }
  const manifestAbsolute = path.join(root, manifestFile);
  let manifestContents: Buffer;
  let manifestJson: unknown;
  try {
    const metadata = statSync(manifestAbsolute);
    if (
      lstatSync(manifestAbsolute).isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink > 1 || // hard link may alias an outside file — refuse (see edit.file)
      metadata.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error('not a regular file');
    }
    manifestContents = readFileSync(manifestAbsolute);
    manifestJson = JSON.parse(manifestContents.toString('utf8'));
    assertRecord(manifestJson, 'edit.manifest_file');
  } catch {
    throw new Error('edit.manifest_file must be a valid regular JSON file');
  }
  const manifestHash = createHash('sha256').update(manifestContents).digest('hex');
  const devScript = nonEmptyString(value.dev_script, 'dev_script');
  const scripts = (manifestJson as Record<string, unknown>).scripts;
  const availableScripts =
    typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
      ? Object.keys(scripts)
      : [];
  if (!availableScripts.includes(devScript)) {
    throw new Error(
      `dev_script must be one of: ${availableScripts.join(', ') || '(none declared)'}`,
    );
  }

  const importLine = nonEmptyString(value.edit.import_line, 'edit.import_line');
  const initBlock = nonEmptyString(value.edit.init_block, 'edit.init_block');
  const anchor = nonEmptyString(value.edit.anchor, 'edit.anchor');
  const position = enumValue(value.edit.position, EDIT_POSITIONS, 'edit position');
  const occurrence = value.edit.occurrence;
  if (!Number.isInteger(occurrence) || (occurrence as number) < 0) {
    throw new Error('edit.occurrence must be a non-negative integer');
  }
  if (countOccurrences(fileContents.toString('utf8'), anchor) <= (occurrence as number)) {
    throw new Error('edit.anchor does not occur at edit.occurrence in edit.file');
  }
  if (!anchorIsWholeLine(fileContents.toString('utf8'), anchor, occurrence as number)) {
    throw new Error('edit.anchor must match the complete non-whitespace content of its line');
  }
  const wiringFailures = validatePlannedWiring({
    file: editFile,
    importLine,
    initBlock,
    apiKeyVariable: apiKey,
    endpointVariable: endpoint,
  });
  if (wiringFailures.length > 0) {
    throw new Error(wiringFailures[0]);
  }

  assertRecord(value.existing_sdk, 'existing_sdk');
  const existingAction = enumValue(
    value.existing_sdk.action,
    EXISTING_SDK_ACTIONS,
    'existing SDK action',
  );
  const existingName =
    value.existing_sdk.name === null
      ? null
      : nonEmptyString(value.existing_sdk.name, 'existing_sdk.name');
  // `keep` and `migrate` describe an action ON a named SDK, so a null name
  // makes the plan unapplyable; `none` means no SDK was found, so a name
  // contradicts it. Apply reads both fields, so the pairing must hold here.
  if ((existingAction === 'keep' || existingAction === 'migrate') && existingName === null) {
    throw new Error(`existing_sdk.name is required when action is ${existingAction}`);
  }
  if (existingAction === 'none' && existingName !== null) {
    throw new Error('existing_sdk.name must be null when action is none');
  }

  return {
    app_dir: appDir,
    framework,
    package_manager: packageManager,
    dev_script: devScript,
    env_prefix: envPrefix,
    env_dir: envDir,
    dependency: { name: '@opslane/sdk', version: OPSLANE_SDK_VERSION },
    env_vars: { api_key: apiKey, endpoint },
    edit: {
      file: editFile,
      entry_hash: entryHash,
      manifest_file: manifestFile,
      manifest_hash: manifestHash,
      import_line: importLine,
      init_block: initBlock,
      anchor,
      position,
      occurrence: occurrence as number,
    },
    existing_sdk: { action: existingAction, name: existingName },
    rationale,
  };
}

export function createAskUserTool(resolver: AskUserResolver | null) {
  return tool(
    'ask_user',
    'Ask the user to choose one or more options before continuing.',
    {
      question: z.string(),
      options: z.array(z.string()).min(1),
      multi: z.boolean().default(false),
    },
    async ({ question, options, multi = false }) => {
      if (resolver === null) {
        throw new Error('ask_user resolver not installed');
      }
      const choices = await resolver({ question, options, multi });
      return {
        content: [{ type: 'text', text: `User chose: ${choices.join(', ')}` }],
      };
    },
  );
}

export function createReportPlanTool(
  root: string,
  onPlan: (plan: OnboardingPlan) => void,
  onUnsupported: (reason: string) => void = () => undefined,
) {
  let reported = false;
  const planShape = z.object({
    app_dir: z.string(),
    framework: z.string(),
    package_manager: z.enum(PACKAGE_MANAGERS),
    dev_script: z.string(),
    env_prefix: z.string(),
    env_dir: z.string(),
    dependency: z.object({
      name: z.literal('@opslane/sdk'),
    }),
    env_vars: z.object({
      api_key: z.string(),
      endpoint: z.string(),
    }),
    edit: z.object({
      file: z.string(),
      // NOTE: no `entry_hash` here on purpose. The Detect agent has only
      // Read/Glob/search and cannot compute a sha256, so requiring it from the
      // model made every report_plan call unsatisfiable (it retried until the
      // turn budget ran out and produced no plan). The host stamps the hash
      // below from the file it already reads. Exact facts belong to code.
      manifest_file: z.string(),
      import_line: z.string(),
      init_block: z.string(),
      anchor: z.string(),
      position: z.enum(EDIT_POSITIONS),
      occurrence: z.number().int().nonnegative(),
    }),
    existing_sdk: z.object({
      action: z.enum(EXISTING_SDK_ACTIONS),
      name: z.string().nullable(),
    }),
    rationale: z.string(),
  });

  return tool(
    'report_plan',
    'Report the validated read-only onboarding plan exactly once.',
    {
      status: z.enum(['ok', 'unsupported']),
      plan: planShape.optional(),
      reason: z.string().optional(),
    },
    async (input) => {
      if (reported) {
        throw new Error('Onboarding plan was already reported');
      }
      assertRecord(input, 'report_plan input');

      if (input.status === 'unsupported') {
        if (input.plan !== undefined) {
          throw new Error('unsupported report must not include a plan');
        }
        const reason = nonEmptyString(input.reason, 'reason');
        reported = true;
        onUnsupported(reason);
        return {
          content: [{ type: 'text', text: 'Unsupported repository result accepted.' }],
        };
      }
      if (input.status !== 'ok') {
        throw new Error('status must be ok or unsupported');
      }
      if (input.reason !== undefined) {
        throw new Error('ok report must not include an unsupported reason');
      }

      const plan = validatePlan(root, input.plan);
      reported = true;
      onPlan(plan);
      return {
        content: [{ type: 'text', text: 'Onboarding plan accepted.' }],
      };
    },
  );
}

export interface FinishApplyReport {
  editedFiles: string[];
  summary: string;
}

export function createFinishApplyTool(
  root: string,
  state: { finished: boolean },
  onReport: (report: FinishApplyReport) => void,
  canFinish: () => boolean = () => true,
) {
  let reported = false;
  return tool(
    'finish_apply',
    'Report the files changed while applying the approved onboarding plan exactly once.',
    {
      edited_files: z.array(z.string()).min(1),
      summary: z.string().min(1),
    },
    async ({ edited_files: editedFiles, summary }) => {
      if (reported || state.finished) {
        throw new Error('Apply result was already finished');
      }
      if (!Array.isArray(editedFiles) || editedFiles.length === 0) {
        throw new Error('edited_files must contain at least one path');
      }
      if (typeof summary !== 'string' || summary.trim().length === 0) {
        throw new Error('summary must be a non-empty string');
      }
      if (!canFinish()) {
        throw new Error('Cannot finish while an edit is unsettled');
      }
      const canonical = editedFiles.map((candidate) => {
        const relative = containedRepoRelative(root, candidate);
        if (hasSecretSegment(relative)) {
          throw new Error('edited_files contains a secret file');
        }
        return relative;
      });
      if (new Set(canonical).size !== canonical.length) {
        throw new Error('edited_files must not contain duplicates');
      }
      onReport({ editedFiles: canonical, summary });
      reported = true;
      state.finished = true;
      return {
        content: [{ type: 'text', text: 'Apply result accepted.' }],
      };
    },
  );
}

export function createOnboardServer(...tools: ServerTool[]) {
  return createSdkMcpServer({ name: 'onboard', version: '0.0.0', tools });
}
