import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../fsutil.js';
import { uncommittedFiles } from '../onboard/worktree.js';
import { restoreSnapshot, snapshotRegularFile } from '../onboard/snapshot.js';
import {
  DEFAULT_PLUGIN_CONTRACT,
  type PluginContractDeps,
} from './vite-contract.js';
import {
  discoverViteProject,
  type ViteDiscoveryDeps,
  type ViteDiscoveryOptions,
  type ViteDiscoveryStatus,
} from './vite-discovery.js';
import { SOURCE_MAP_DISCLOSURE } from './vite-messages.js';
import {
  resolveViteConfig,
  type ResolveOptions,
  type ViteResolveResult,
} from './vite-resolve.js';
import {
  addOpslanePlugin,
  configSetsBuildSourcemap,
  suggestionAtLine,
  type ViteEditResult,
} from './vite-sourcemaps.js';

export type ViteTransactionStatus =
  | ViteDiscoveryStatus
  | 'consent_required'
  | 'edited'
  | 'already_wired'
  | 'unsupported'
  | 'legacy_opslane_plugin'
  | 'vite_config_broken_before_edit'
  | 'vite_config_parse_failed'
  | 'vite_config_structure_mismatch'
  | 'vite_plugin_not_registered'
  | 'vite_config_broken_after_edit'
  | 'vite_config_resolve_timeout'
  | 'config_changed_before_write'
  | 'repo_changed_during_verification'
  | 'write_failed'
  | 'restore_failed';

export interface ViteTransactionOptions extends Omit<ViteDiscoveryOptions, 'contract'> {
  apply?: boolean;
  check?: boolean;
  /** Binds interactive consent to the exact preview that was shown. */
  expectedDiff?: string;
  /** Applies a user-selected insertion line within a suggested plugin array. */
  suggestionLine?: number;
}

export interface ViteTransactionResult {
  status: ViteTransactionStatus;
  file?: string;
  diff?: string;
  disclosure?: string;
  warnings?: string[];
  reason?: string;
  restoreFailures?: string[];
  recoveryPath?: string;
  candidates?: Array<{ file: string; hasIndexHtml: boolean }>;
  suggestion?: {
    insertOffset: number;
    line: number;
    preview: string[];
  };
}

export interface ViteTransactionDeps {
  contract?: PluginContractDeps;
  discovery?: ViteDiscoveryDeps;
  resolve?: (options: ResolveOptions) => Promise<ViteResolveResult>;
  writeAtomic?: (file: string, text: string | Buffer, mode?: number) => Promise<void>;
  restore?: typeof restoreSnapshot;
  gitStatus?: (root: string, excludedRelative?: string) => string | null;
  dirtyFiles?: (root: string) => string[] | null;
  codemod?: typeof addOpslanePlugin;
}

function gitStatus(root: string, excludedRelative?: string): string | null {
  try {
    const pathspec = excludedRelative
      ? ['--', '.', `:(exclude)${excludedRelative}`]
      : [];
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathspec],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let trackedDiff = '';
    try {
      trackedDiff = execFileSync(
        'git',
        ['diff', '--binary', 'HEAD', ...pathspec],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      // An unborn repository has no HEAD; status plus untracked hashes still
      // provides a stable before/after fingerprint.
    }
    const untrackedHashes = status
      .split('\0')
      .filter((record) => record.startsWith('?? '))
      .map((record) => record.slice(3))
      .sort()
      .map((relative) => {
        try {
          const contents = readFileSync(path.join(root, relative));
          return `${relative}:${createHash('sha256').update(contents).digest('hex')}`;
        } catch {
          return `${relative}:unreadable`;
        }
      })
      .join('\n');
    return createHash('sha256')
      .update(status)
      .update('\0')
      .update(trackedDiff)
      .update('\0')
      .update(untrackedHashes)
      .digest('hex');
  } catch {
    return null;
  }
}

function simpleDiff(file: string, before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix]
      === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + 3);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + 3);
  const body = [
    ...beforeLines.slice(contextStart, prefix).map((line) => ` ${line}`),
    ...beforeLines.slice(prefix, beforeLines.length - suffix).map((line) => `-${line}`),
    ...afterLines.slice(prefix, afterLines.length - suffix).map((line) => `+${line}`),
    ...afterLines.slice(afterLines.length - suffix, afterEnd).map((line) => ` ${line}`),
  ].join('\n');
  const diff = `--- ${file}\n+++ ${file}\n@@ -${contextStart + 1} +${contextStart + 1} @@\n${body}`;
  return diff.length > 32_768
    ? `${diff.slice(0, 32_700)}\n... diff truncated ...`
    : diff;
}

function failedResolveStatus(
  result: Extract<ViteResolveResult, { ok: false }>,
  beforeEdit: boolean,
): ViteTransactionStatus {
  if (!beforeEdit && result.reason === 'vite_resolve_timeout') {
    return 'vite_config_resolve_timeout';
  }
  return beforeEdit ? 'vite_config_broken_before_edit' : 'vite_config_broken_after_edit';
}

function editTerminal(
  edit: Exclude<ViteEditResult, { outcome: 'edited' | 'suggested' }>,
  file: string,
): ViteTransactionResult {
  if (edit.outcome === 'already_wired') return { status: 'already_wired', file };
  if (edit.outcome === 'legacy_opslane_plugin') return { status: edit.outcome, file };
  return { status: 'unsupported', file, reason: edit.reason };
}

function assertParentContained(repoRoot: string, file: string): void {
  const rootReal = realpathSync(repoRoot);
  const parentReal = realpathSync(path.dirname(file));
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
    throw new Error('config parent escaped the repository');
  }
}

export async function runViteTransaction(
  options: ViteTransactionOptions,
  deps: ViteTransactionDeps = {},
): Promise<ViteTransactionResult> {
  const contract = deps.contract ?? DEFAULT_PLUGIN_CONTRACT;
  const resolve = deps.resolve ?? resolveViteConfig;
  const writeAtomic = deps.writeAtomic ?? writeFileAtomic;
  const restore = deps.restore ?? restoreSnapshot;
  const statusReader = deps.gitStatus ?? gitStatus;
  const codemod = deps.codemod ?? addOpslanePlugin;
  const discovery = await discoverViteProject(
    { ...options, contract },
    deps.discovery,
  );
  if (!discovery.ok) {
    return {
      status: discovery.status,
      reason: discovery.message,
      ...(discovery.candidates ? { candidates: discovery.candidates } : {}),
    };
  }

  const originalText = discovery.snapshot.contents.toString('utf8');
  if (options.check) {
    const checked = await resolve({
      appDir: discovery.appDir,
      configPath: discovery.configPath,
    });
    if (!checked.ok) {
      return {
        status: failedResolveStatus(checked, true),
        file: discovery.configRelative,
        reason: checked.error ?? checked.reason,
      };
    }
    return checked.pluginNames.includes(contract.pluginName)
      ? { status: 'already_wired', file: discovery.configRelative }
      : { status: 'vite_plugin_not_registered', file: discovery.configRelative };
  }

  const policy = { contract };
  let edit = codemod(originalText, discovery.configRelative, policy);
  if (edit.outcome === 'suggested' && options.suggestionLine !== undefined) {
    edit = suggestionAtLine(
      originalText,
      discovery.configRelative,
      options.suggestionLine,
      policy,
    );
  }
  if (edit.outcome !== 'edited' && edit.outcome !== 'suggested') {
    return editTerminal(edit, discovery.configRelative);
  }

  const dirty = (deps.dirtyFiles ?? uncommittedFiles)(options.repoRoot);
  const warnings: string[] = [];
  if (dirty?.includes(discovery.configRelative)) {
    warnings.push('This config already has uncommitted changes; the edit will be mixed with them.');
  }
  if (configSetsBuildSourcemap(originalText, discovery.configRelative)) {
    warnings.push('This config sets build.sourcemap; the Opslane plugin overrides that setting.');
  }
  const proposal: ViteTransactionResult = {
    status: 'consent_required',
    file: discovery.configRelative,
    diff: simpleDiff(discovery.configRelative, originalText, edit.text),
    disclosure: SOURCE_MAP_DISCLOSURE,
    warnings,
    ...(edit.outcome === 'suggested'
      ? {
          suggestion: {
            insertOffset: edit.insertOffset,
            line: edit.line,
            preview: edit.preview,
          },
        }
      : {}),
  };
  if (!options.apply) return proposal;
  if (options.expectedDiff !== undefined && options.expectedDiff !== proposal.diff) {
    return {
      status: 'config_changed_before_write',
      file: discovery.configRelative,
      reason: 'The proposed diff changed after consent.',
    };
  }

  const beforeStatus = statusReader(options.repoRoot);
  const beforeWithoutConfig = statusReader(options.repoRoot, discovery.configRelative);
  let baseline: ViteResolveResult;
  try {
    baseline = await resolve({
      appDir: discovery.appDir,
      configPath: discovery.configPath,
    });
  } catch (error) {
    return {
      status: 'vite_config_broken_before_edit',
      file: discovery.configRelative,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!baseline.ok) {
    return {
      status: failedResolveStatus(baseline, true),
      file: discovery.configRelative,
      reason: baseline.error ?? baseline.reason,
    };
  }
  const afterBaselineStatus = statusReader(options.repoRoot);
  if (
    beforeStatus !== null
    && afterBaselineStatus !== null
    && beforeStatus !== afterBaselineStatus
  ) {
    return {
      status: 'repo_changed_during_verification',
      file: discovery.configRelative,
      reason: 'The unedited config changed the repository while Vite loaded it.',
    };
  }

  let current;
  try {
    current = snapshotRegularFile(
      options.repoRoot,
      discovery.configRelative,
      4 * 1024 * 1024,
    );
  } catch (error) {
    return {
      status: 'config_changed_before_write',
      file: discovery.configRelative,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!current.contents.equals(discovery.snapshot.contents)) {
    return {
      status: 'config_changed_before_write',
      file: discovery.configRelative,
      reason: 'The config changed after the proposed diff was prepared.',
    };
  }

  const rollback = async (
    failure: ViteTransactionResult,
  ): Promise<ViteTransactionResult> => {
    let restoreFailure: string | undefined;
    try {
      restoreFailure = restore(current);
    } catch (error) {
      restoreFailure = `${current.relative}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (restoreFailure) {
      const recoveryPath = path.join(
        options.repoRoot,
        '.opslane-recovery',
        `${path.basename(current.relative)}.${randomUUID()}.backup`,
      );
      const restoreFailures = [restoreFailure];
      try {
        await writeAtomic(recoveryPath, current.contents, current.mode);
      } catch (error) {
        restoreFailures.push(`backup: ${error instanceof Error ? error.message : String(error)}`);
        return {
          status: 'restore_failed',
          file: current.relative,
          reason: failure.status,
          restoreFailures,
        };
      }
      return {
        status: 'restore_failed',
        file: current.relative,
        reason: failure.status,
        restoreFailures,
        recoveryPath,
      };
    }
    const restoredStatus = statusReader(options.repoRoot, current.relative);
    if (
      beforeWithoutConfig !== null
      && restoredStatus !== null
      && beforeWithoutConfig !== restoredStatus
    ) {
      return {
        status: 'repo_changed_during_verification',
        file: current.relative,
        reason: `Rollback restored the config, but another repository path changed (${failure.status}).`,
      };
    }
    return failure;
  };

  try {
    assertParentContained(options.repoRoot, current.absolute);
    await writeAtomic(current.absolute, edit.text, current.mode);
  } catch (error) {
    return await rollback({
      status: 'write_failed',
      file: current.relative,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const expected = Buffer.from(edit.text, 'utf8');
    const written = readFileSync(current.absolute);
    if (!written.equals(expected)) {
      return await rollback({
        status: 'vite_config_structure_mismatch',
        file: current.relative,
        reason: 'The bytes read from disk differ from the proposed edit.',
      });
    }
    const structural = codemod(written.toString('utf8'), current.relative, policy);
    if (structural.outcome !== 'already_wired') {
      return await rollback({
        status: structural.outcome === 'unsupported'
          && structural.reason === 'unsupported_config_shape'
          ? 'vite_config_parse_failed'
          : 'vite_config_structure_mismatch',
        file: current.relative,
        reason: structural.outcome,
      });
    }

    const verified = await resolve({
      appDir: discovery.appDir,
      configPath: discovery.configPath,
    });
    if (!verified.ok) {
      return await rollback({
        status: failedResolveStatus(verified, false),
        file: current.relative,
        reason: verified.error ?? verified.reason,
      });
    }
    if (!verified.pluginNames.includes(contract.pluginName)) {
      return await rollback({
        status: 'vite_plugin_not_registered',
        file: current.relative,
      });
    }
    if (!readFileSync(current.absolute).equals(expected)) {
      return await rollback({
        status: 'vite_config_structure_mismatch',
        file: current.relative,
        reason: 'The config changed while Vite resolved it.',
      });
    }

    // Git does not report ignored paths. This proves the visible repository
    // delta; Vite config execution itself is disclosed as unsandboxed.
    const finalStatus = statusReader(options.repoRoot, current.relative);
    if (
      beforeWithoutConfig !== null
      && finalStatus !== null
      && beforeWithoutConfig !== finalStatus
    ) {
      return await rollback({
        status: 'repo_changed_during_verification',
        file: current.relative,
        reason: 'A repository path other than the selected Vite config changed.',
      });
    }
  } catch (error) {
    return await rollback({
      status: 'vite_config_broken_after_edit',
      file: current.relative,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    status: 'edited',
    file: current.relative,
    diff: proposal.diff,
    disclosure: proposal.disclosure,
    warnings,
  };
}
