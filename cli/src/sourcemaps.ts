import inquirer from 'inquirer';

import type { AgentStatus } from './contract.js';
import { exitWithStatus } from './output.js';
import {
  renderInstallPlan,
  renderSuggestion,
  renderViteOutcome,
} from './codemods/vite-messages.js';
import type { ViteUnsupportedReason } from './codemods/vite-sourcemaps.js';
import {
  runViteTransaction,
  type ViteTransactionOptions,
  type ViteTransactionResult,
} from './codemods/vite-transaction.js';

export interface SourcemapsOptions {
  config?: string;
  appDir?: string;
  yes?: boolean;
  json?: boolean;
  check?: boolean;
}

export interface SourcemapsCommandDeps {
  cwd?: string;
  transaction?: typeof runViteTransaction;
  isTTY?: boolean;
  confirm?: (message: string) => Promise<boolean>;
  chooseSuggestion?: (
    message: string,
  ) => Promise<{ action: 'yes' | 'move' | 'no'; line?: number }>;
  show?: (message: string) => void;
  exit?: (status: AgentStatus, data: Record<string, unknown>, code: 0 | 1) => void;
}

function exitCode(result: ViteTransactionResult): 0 | 1 {
  return result.status === 'edited' || result.status === 'already_wired' ? 0 : 1;
}

function dataFor(result: ViteTransactionResult): Record<string, unknown> {
  const { status: _status, ...data } = result;
  const message = remediationFor(result);
  return message ? { ...data, message } : data;
}

function remediationFor(result: ViteTransactionResult): string | undefined {
  const file = result.file ?? 'vite.config';
  if (result.status === 'unsupported') {
    return renderViteOutcome(file, {
      outcome: 'unsupported',
      reason: (result.reason ?? 'unsupported_config_shape') as ViteUnsupportedReason,
    });
  }
  if (result.status === 'legacy_opslane_plugin') {
    return renderViteOutcome(file, { outcome: 'legacy_opslane_plugin' });
  }
  return undefined;
}

async function confirmInstall(message: string): Promise<boolean> {
  const answer = await inquirer.prompt<{ confirmed: boolean }>([
    {
      type: 'confirm',
      name: 'confirmed',
      message,
      default: false,
    },
  ]);
  return answer.confirmed;
}

async function chooseSuggestion(
  message: string,
): Promise<{ action: 'yes' | 'move' | 'no'; line?: number }> {
  const choice = await inquirer.prompt<{ action: 'yes' | 'move' | 'no' }>([
    {
      type: 'list',
      name: 'action',
      message,
      choices: [
        { name: 'Yes', value: 'yes' },
        { name: 'Move it', value: 'move' },
        { name: 'No, show me the two lines', value: 'no' },
      ],
    },
  ]);
  if (choice.action !== 'move') return choice;
  const moved = await inquirer.prompt<{ line: number }>([
    {
      type: 'input',
      name: 'line',
      message: 'Config line to insert before:',
      filter: (value: string) => Number(value),
      validate: (value: number) =>
        Number.isInteger(value) && value > 0 ? true : 'Enter a positive line number.',
    },
  ]);
  return { action: 'move', line: moved.line };
}

export async function runSourcemapsCommand(
  options: SourcemapsOptions,
  deps: SourcemapsCommandDeps = {},
): Promise<void> {
  const transaction = deps.transaction ?? runViteTransaction;
  const cwd = deps.cwd ?? process.cwd();
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const show = deps.show ?? ((message: string) => console.error(message));
  const confirm = deps.confirm ?? confirmInstall;
  const choose = deps.chooseSuggestion ?? chooseSuggestion;
  const exit = deps.exit
    ?? ((status, data, code) => exitWithStatus(status, data, code));
  const base: ViteTransactionOptions = {
    repoRoot: cwd,
    ...(options.appDir ? { appDir: options.appDir } : {}),
    ...(options.config ? { config: options.config } : {}),
  };

  if (options.check && options.yes) {
    exit('usage_error', {
      message: '--check verifies without writing and cannot be combined with --yes.',
    }, 1);
    return;
  }

  if (options.check) {
    const checked = await transaction({ ...base, check: true });
    exit(checked.status as AgentStatus, dataFor(checked), exitCode(checked));
    return;
  }

  if (options.yes) {
    const applied = await transaction({ ...base, apply: true });
    exit(applied.status as AgentStatus, dataFor(applied), exitCode(applied));
    return;
  }

  const proposal = await transaction(base);
  if (proposal.status !== 'consent_required') {
    exit(proposal.status as AgentStatus, dataFor(proposal), exitCode(proposal));
    return;
  }

  if (!isTTY || options.json) {
    exit('consent_required', dataFor(proposal), 1);
    return;
  }

  show(renderInstallPlan(
    proposal.file ?? 'vite.config',
    proposal.diff ?? '',
    proposal.warnings,
  ));
  let acceptedProposal = proposal;
  let suggestionLine: number | undefined;
  if (proposal.suggestion) {
    show(renderSuggestion(proposal.file ?? 'vite.config', proposal.suggestion));
    const choice = await choose('Add the Opslane plugin at the marked line?');
    if (choice.action === 'no') {
      exit('consent_required', {
        ...dataFor(proposal),
        message: 'No files were changed.',
      }, 1);
      return;
    }
    if (choice.action === 'move') {
      suggestionLine = choice.line;
      acceptedProposal = await transaction({ ...base, suggestionLine });
      if (acceptedProposal.status !== 'consent_required') {
        exit(
          acceptedProposal.status as AgentStatus,
          dataFor(acceptedProposal),
          exitCode(acceptedProposal),
        );
        return;
      }
      if (acceptedProposal.suggestion) {
        show(renderSuggestion(
          acceptedProposal.file ?? 'vite.config',
          acceptedProposal.suggestion,
        ));
      }
      if (!await confirm('Add the Opslane plugin at this moved line and verify the config?')) {
        exit('consent_required', {
          ...dataFor(acceptedProposal),
          message: 'No files were changed.',
        }, 1);
        return;
      }
    }
  } else if (!await confirm('Add the Opslane Vite plugin and verify the config?')) {
    exit('consent_required', {
      ...dataFor(proposal),
      message: 'No files were changed.',
    }, 1);
    return;
  }

  const applied = await transaction({
    ...base,
    apply: true,
    expectedDiff: acceptedProposal.diff,
    ...(suggestionLine === undefined ? {} : { suggestionLine }),
  });
  exit(applied.status as AgentStatus, dataFor(applied), exitCode(applied));
}
