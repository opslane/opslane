#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { login } from './login.js';
import { init } from './init.js';
import { doctor } from './doctor.js';
import { setup } from './setup.js';
import { snippet } from './snippet.js';
import { verify } from './verify.js';
import { status } from './status.js';
import { listErrors, getError } from './errors.js';
import { AGENT_STATUSES } from './contract.js';
import { jsonOutput } from './output.js';
import chalk from 'chalk';

// Derive the version from package.json so Changesets bumps propagate to
// `opslane --version` without a hand edit (dist/index.js -> ../package.json).
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

const program = new Command();

program
  .name('opslane')
  .description('Opslane CLI - AI-powered production error resolution')
  .version(pkg.version);

program
  .addOption(new Option('--contract', 'Print the machine-readable agent contract').hideHelp())
  .action((opts: { contract?: boolean }) => {
    if (opts.contract) jsonOutput({ statuses: AGENT_STATUSES });
  });

program
  .command('login')
  .description('Authenticate with Opslane and connect GitHub')
  .option('--api-url <url>', 'Opslane API URL')
  .action(async (opts: { apiUrl?: string }) => {
    try {
      await login({
        apiUrl: opts.apiUrl ?? process.env['OPSLANE_API_URL'] ?? 'https://api.opslane.com',
        clientId: process.env['OPSLANE_CLIENT_ID'] ?? 'opslane-cli',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\nLogin failed: ${message}`));
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('Initialize Opslane in the current project')
  .option('--api-key <key>', 'Your Opslane API key')
  .action((opts: { apiKey?: string }) => init({ apiKey: opts.apiKey }));

program
  .command('doctor')
  .description('Check Opslane setup health')
  .option('--fix', 'Attempt to auto-fix common issues')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Repository to inspect')
  .action(async (opts: { fix?: boolean; apiUrl?: string; repo?: string }) => {
    await doctor(opts);
  });

// Agent-first onboarding commands
program
  .command('setup')
  .description('Set up Opslane for this repo (agent-first onboarding)')
  .option('--start', 'Create a setup session without polling')
  .option('--poll <id>', 'Resume polling an existing setup session')
  .option('--timeout <seconds>', 'Polling timeout in seconds')
  .option('--force', 'Bypass local credential validation')
  .option('--relink', 'Mint a replacement key using an authenticated login')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Override auto-detected repository')
  .option('--repo-url <url>', 'Override auto-detected repo URL')
  .option('--agent-name <name>', 'Agent identifier (e.g., "claude-code")')
  .action(async (opts: {
    start?: boolean; poll?: string; timeout?: string; force?: boolean; relink?: boolean;
    apiUrl?: string; repo?: string; repoUrl?: string; agentName?: string;
  }) => {
    await setup(opts);
  });

program
  .command('onboard')
  .description('Agent-guided SDK onboarding for the repo in the current directory')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Override auto-detected repository')
  .action(async (opts: { apiUrl?: string; repo?: string }) => {
    const { runOnboardCommand } = await import('./onboard/command.js');
    await runOnboardCommand(opts);
  });

program
  .command('snippet')
  .description('Get framework-specific SDK init code')
  .option('--framework <name>', 'Override auto-detected framework')
  .option('--api-key <key>', 'API key to embed in snippet')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Repository to inspect')
  .action(async (opts: { framework?: string; apiKey?: string; apiUrl?: string; repo?: string }) => {
    await snippet(opts);
  });

program
  .command('verify')
  .description('Check if Opslane is connected and receiving events')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Repository to inspect')
  .action(async (opts: { apiUrl?: string; repo?: string }) => {
    await verify(opts);
  });

program
  .command('status')
  .description('Show current Opslane project and auth state')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Repository to inspect')
  .action(async (opts: { apiUrl?: string; repo?: string }) => {
    await status(opts);
  });

const errorsCmd = program
  .command('errors')
  .description('View error groups');

errorsCmd
  .command('list')
  .description('List error groups')
  .option('--status <status>', 'Filter by status')
  .option('--limit <n>', 'Maximum results', '25')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Repository to inspect')
  .action(async (opts: { status?: string; limit?: string; apiUrl?: string; repo?: string }) => {
    await listErrors({ ...opts, limit: parseInt(opts.limit ?? '25', 10) });
  });

errorsCmd
  .command('get <id>')
  .description('Get error group details')
  .option('--api-url <url>', 'Opslane API URL')
  .option('--repo <owner/repo>', 'Repository to inspect')
  .action(async (id: string, opts: { apiUrl?: string; repo?: string }) => {
    await getError(id, opts);
  });

await program.parseAsync(process.argv);
