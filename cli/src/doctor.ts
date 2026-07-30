import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { defaultTokenPath, loadTokensFrom } from './auth.js';
import { defaultCredentialsPath, resolveCredentials } from './agent-credentials.js';
import { defaultApiUrl } from './config.js';
import { detectRepoFromGit } from './setup.js';
import { canonicalOrigin } from './origin.js';

export interface DoctorOptions {
  fix?: boolean;
  /** Override the API URL for testing. */
  apiUrl?: string;
  /** Override the working directory for testing. */
  cwd?: string;
  /** Injectable fetch for testing. */
  fetchFn?: typeof fetch;
  repo?: string;
  credentialsPath?: string;
  tokenPath?: string;
  /** Explicit build output directory for the debug-ID check. */
  dist?: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  remediation?: string;
}

type CheckFn = () => Promise<CheckResult>;

function getApiUrl(options: DoctorOptions): string {
  return canonicalOrigin(options.apiUrl ?? defaultApiUrl());
}

/**
 * Build the list of health checks.
 */
function buildChecks(options: DoctorOptions): CheckFn[] {
  const cwd = options.cwd ?? process.cwd();
  const apiUrl = getApiUrl(options);
  const fetchImpl = options.fetchFn ?? fetch;
  const repo = options.repo ?? detectRepoFromGit(cwd);
  const resolveAgentCredentials = () => resolveCredentials({
    apiUrl,
    repo,
    filePath: options.credentialsPath ?? defaultCredentialsPath(),
  });
  const resolveLoginTokens = () => loadTokensFrom(
    options.tokenPath ?? defaultTokenPath(),
    apiUrl,
  );

  return [
    // Check 1: .opslane.json is optional for agent-first setup.
    async (): Promise<CheckResult> => {
      try {
        await access(join(cwd, '.opslane.json'));
        return {
          name: 'Project config',
          passed: true,
          message: '.opslane.json found',
        };
      } catch {
        return {
          name: 'Project config',
          passed: true,
          message: '.opslane.json not found (optional for agent-first setup)',
        };
      }
    },

    // Check 2: Credentials exist and not expired
    async (): Promise<CheckResult> => {
      const [agentCredentials, tokens] = await Promise.all([
        resolveAgentCredentials(),
        resolveLoginTokens(),
      ]);
      if (agentCredentials || tokens) {
        return {
          name: 'Authentication',
          passed: true,
          message: agentCredentials ? 'Agent API credentials found' : 'Valid login credentials found',
        };
      }
      return {
        name: 'Authentication',
        passed: false,
        message: 'No valid credentials found (missing or expired)',
        remediation: 'Run `opslane login`',
      };
    },

    // Check 3: Ingestion reachable
    async (): Promise<CheckResult> => {
      try {
        const response = await fetchImpl(`${apiUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return {
            name: 'Ingestion service',
            passed: true,
            message: `Reachable at ${apiUrl}`,
          };
        }
        return {
          name: 'Ingestion service',
          passed: false,
          message: `Responded with status ${response.status}`,
          remediation:
            'Check OPSLANE_API_URL or ensure services are running',
        };
      } catch {
        return {
          name: 'Ingestion service',
          passed: false,
          message: `Cannot reach ${apiUrl}`,
          remediation:
            'Check OPSLANE_API_URL or ensure services are running',
        };
      }
    },

    // Check 4: User session valid
    async (): Promise<CheckResult> => {
      try {
        const tokens = await resolveLoginTokens();
        if (!tokens) {
          return {
            name: 'Session',
            passed: false,
            message: 'Not signed in',
            remediation: 'Run `opslane login`',
          };
        }
        const response = await fetchImpl(`${apiUrl}/api/v1/auth/verify`, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return {
            name: 'Session',
            passed: true,
            message: 'Signed in',
          };
        }
        return {
          name: 'Session',
          passed: false,
          message: `Not signed in (status ${response.status})`,
          remediation: 'Run `opslane login`',
        };
      } catch {
        return {
          name: 'Session',
          passed: false,
          message: 'Could not verify session',
          remediation: 'Run `opslane login`',
        };
      }
    },

    // Check 5: Browser ingest key valid
    async (): Promise<CheckResult> => {
      try {
        const agentCredentials = await resolveAgentCredentials();
        if (!agentCredentials) {
          return {
            name: 'Ingest key',
            passed: false,
            message: 'No stored key',
            remediation: 'Run `opslane onboard` in this repo',
          };
        }
        const response = await fetchImpl(`${agentCredentials.api_url}/api/v1/ingest/ping`, {
          method: 'POST',
          headers: { 'X-API-Key': agentCredentials.api_key },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          return {
            name: 'Ingest key',
            passed: true,
            message: 'Ingest key is valid',
          };
        }
        return {
          name: 'Ingest key',
          passed: false,
          message: `Ingest key rejected (status ${response.status})`,
          remediation: 'Run `opslane onboard` to mint a replacement, then redeploy',
        };
      } catch {
        return {
          name: 'Ingest key',
          passed: false,
          message: 'Could not verify ingest key',
          remediation: 'Run `opslane onboard` to mint a replacement, then redeploy',
        };
      }
    },

    // Check 5: production chunks carry debug IDs.
    async (): Promise<CheckResult> => {
      const outDir = await resolveBuildOutput(cwd, options.dist);
      let files: string[];
      try {
        files = await listFiles(outDir);
      } catch {
        return {
          name: 'Debug IDs',
          passed: true,
          message: `Build output not found at ${outDir} (not built yet)`,
        };
      }
      if (files.length === 0) {
        return {
          name: 'Debug IDs',
          passed: true,
          message: `Build output at ${outDir} is empty (not built yet)`,
        };
      }

      const chunks = files.filter((file) => file.endsWith('.js'));
      let stamped = 0;
      for (const chunk of chunks) {
        if ((await readFile(chunk, 'utf8')).includes('//# debugId=')) stamped++;
      }
      if (stamped > 0) {
        return {
          name: 'Debug IDs',
          passed: true,
          message: `${stamped}/${chunks.length} JavaScript chunks stamped in ${outDir}`,
        };
      }
      return {
        name: 'Debug IDs',
        passed: false,
        message: `No stamped JavaScript chunks found in ${outDir}`,
        remediation:
          'Add the Opslane Vite plugin, run a production build, then rerun `opslane doctor --dist <path>`',
      };
    },
  ];
}

async function resolveBuildOutput(cwd: string, explicit?: string): Promise<string> {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
  try {
    const requireFromProject = createRequire(join(cwd, 'package.json'));
    const viteEntry = requireFromProject.resolve('vite');
    const vite = (await import(pathToFileURL(viteEntry).href)) as {
      resolveConfig?: (
        config: { root: string },
        command: 'build',
      ) => Promise<{ root: string; build: { outDir: string } }>;
    };
    if (vite.resolveConfig) {
      const config = await vite.resolveConfig({ root: cwd }, 'build');
      return isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir);
    }
  } catch {
    // Vite is optional; fall back to its conventional output directory.
  }
  return join(cwd, 'dist');
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
}

/**
 * Run all health checks and report results.
 */
export async function doctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const checkFns = buildChecks(options);
  const results: CheckResult[] = [];

  console.log(chalk.bold('\nOpslane Doctor\n'));

  for (const checkFn of checkFns) {
    const result = await checkFn();
    results.push(result);

    const icon = result.passed
      ? chalk.green('PASS')
      : chalk.red('FAIL');

    console.log(`[${icon}] ${result.name}: ${result.message}`);

    if (!result.passed && result.remediation) {
      console.log(chalk.dim(`       Fix: ${result.remediation}`));
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;

  console.log('');
  if (passed === total) {
    console.log(chalk.green(`All ${total} checks passed!`));
  } else {
    console.log(
      chalk.yellow(
        `${passed}/${total} checks passed. Run the suggested fixes above.`,
      ),
    );
  }

  return results;
}
