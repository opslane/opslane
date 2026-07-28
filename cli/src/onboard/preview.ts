import { constants, openSync, readFileSync, closeSync } from 'node:fs';
import path from 'node:path';

import { containedRepoRelative } from './paths.js';
import {
  devCommand,
  formatCommand,
  installCommand,
} from './process.js';
import type { OnboardingPlan } from './tools.js';

export interface ActionPreview {
  readonly entryFile: string;
  readonly manifestFile: string;
  readonly addedDependency: string;
  readonly envFile: string;
  readonly envKeysAdded: readonly string[];
  readonly envKeysReplaced: readonly string[];
  readonly gitignoreWillChange: boolean;
  /**
   * False on an already-wired repository (`no_op`), where the entry file and
   * manifest are left alone. The preview has to say this itself: callers that
   * only receive the preview, such as the approval prompt, cannot otherwise
   * tell the difference between "wire it up" and "nothing to do".
   */
  readonly editsCode: boolean;
  readonly installCommand: string | null;
  readonly devCommand: string;
  readonly devCwd: string;
  readonly insert: {
    readonly anchor: string;
    readonly position: 'before' | 'after';
    readonly lines: readonly string[];
  };
}

/** Read without following a final-component symlink. Missing files are empty. */
function readOptionalFile(file: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function displayBlockLines(block: string): string[] {
  const lines = block.replaceAll('\r\n', '\n').split('\n');
  while (lines[0]?.trim() === '') lines.shift();
  while (lines.at(-1)?.trim() === '') lines.pop();
  const indentation = lines
    .filter((line) => line.trim() !== '')
    .map((line) => line.match(/^[\t ]*/)?.[0].length ?? 0);
  const commonIndent = indentation.length === 0 ? 0 : Math.min(...indentation);
  return lines.map((line) => line.slice(commonIndent));
}

export function buildActionPreview({
  cwd,
  plan,
  envValues,
}: {
  cwd: string;
  plan: OnboardingPlan;
  envValues: Record<string, string>;
}): ActionPreview {
  const appDir = containedRepoRelative(cwd, plan.app_dir) || '.';
  const envDir = containedRepoRelative(cwd, plan.env_dir) || '.';
  const envFile = path.posix.join(envDir, '.env.local');
  const envContents = readOptionalFile(path.join(cwd, envFile));
  const envKeysAdded: string[] = [];
  const envKeysReplaced: string[] = [];

  for (const [name, value] of Object.entries(envValues)) {
    const match = new RegExp(`^${name}=.*$`, 'm').exec(envContents);
    if (match === null) envKeysAdded.push(name);
    else if (match[0] !== `${name}=${value}`) envKeysReplaced.push(name);
  }

  const gitignore = readOptionalFile(path.join(cwd, envDir, '.gitignore'));
  const changesCode = plan.existing_sdk.action !== 'no_op';

  const insert = Object.freeze({
    anchor: plan.edit.anchor,
    position: plan.edit.position,
    lines: Object.freeze([
      plan.edit.import_line,
      ...displayBlockLines(plan.edit.init_block),
    ]),
  });

  return Object.freeze({
    entryFile: plan.edit.file,
    manifestFile: plan.edit.manifest_file,
    addedDependency: `${plan.dependency.name}@${plan.dependency.version}`,
    envFile,
    envKeysAdded: Object.freeze(envKeysAdded),
    envKeysReplaced: Object.freeze(envKeysReplaced),
    gitignoreWillChange: !gitignore.split(/\r?\n/).includes('.env.local'),
    editsCode: plan.existing_sdk.action !== 'no_op',
    installCommand: changesCode
      ? formatCommand(installCommand(cwd, appDir, plan.package_manager))
      : null,
    devCommand: formatCommand(
      devCommand(cwd, appDir, plan.dev_script, plan.package_manager),
    ),
    devCwd: appDir,
    insert,
  });
}
