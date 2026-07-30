import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { detectFramework, type Framework } from './detect.js';
import { getCodemod } from './codemods/registry.js';
import { generateFallbackPatches } from './ai-fallback.js';
import type { FilePatch } from './codemods/types.js';
import { writeEnvLocal } from './envfile.js';

/**
 * Format patches as a human-readable diff preview.
 */
function formatPatchPreview(patches: FilePatch[]): string {
  const lines: string[] = [];

  for (const patch of patches) {
    if (patch.action === 'create' || patch.action === 'replace') {
      const label = patch.action === 'create' ? '+ CREATE' : '~ REPLACE';
      lines.push(chalk.green(`${label} ${patch.filePath}`));
      if (patch.content) {
        for (const line of patch.content.split('\n').slice(0, 10)) {
          lines.push(chalk.green(`  + ${line}`));
        }
        const totalLines = patch.content.split('\n').length;
        if (totalLines > 10) {
          lines.push(chalk.dim(`  ... (${totalLines - 10} more lines)`));
        }
      }
    } else {
      lines.push(chalk.yellow(`~ MODIFY ${patch.filePath}`));
      if (patch.insertAfter) {
        lines.push(chalk.dim(`  after: "${patch.insertAfter}"`));
      }
      if (patch.insertContent) {
        for (const line of patch.insertContent.split('\n')) {
          lines.push(chalk.green(`  + ${line}`));
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Apply patches to the project filesystem.
 */
export async function applyPatches(
  projectRoot: string,
  patches: FilePatch[],
): Promise<void> {
  for (const patch of patches) {
    const fullPath = join(projectRoot, patch.filePath);

    if (patch.action === 'create' || patch.action === 'replace') {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, patch.content ?? '', 'utf-8');
    } else if (
      patch.action === 'modify' &&
      patch.insertAfter !== undefined &&
      patch.insertContent !== undefined
    ) {
      const existing = await readFile(fullPath, 'utf-8');
      const idx = existing.indexOf(patch.insertAfter);

      if (idx === -1) {
        console.warn(
          chalk.yellow(
            `Warning: pattern "${patch.insertAfter}" not found in ${patch.filePath}, skipping patch`,
          ),
        );
        continue;
      }

      const insertPos = idx + patch.insertAfter.length;
      const beforeContent = insertPos === 0 ? '' : '\n';
      const afterContent = insertPos === 0 ? '\n' : '';
      const patched =
        existing.slice(0, insertPos) +
        beforeContent +
        patch.insertContent +
        afterContent +
        existing.slice(insertPos);

      await writeFile(fullPath, patched, 'utf-8');
    }
  }
}

export interface InitOptions {
  cwd?: string;
  /** Skip interactive prompts (for testing). */
  nonInteractive?: boolean;
  /** Project ID to use (skips prompt). */
  projectId?: string;
  /** API key supplied by legacy callers. It is never written to source or config. */
  apiKey?: string;
}

function apiKeyEnvironmentVariable(framework: Framework): string {
  if (framework === 'react-vite' || framework === 'vue-vite') return 'VITE_OPSLANE_API_KEY';
  if (framework === 'nextjs') return 'NEXT_PUBLIC_OPSLANE_API_KEY';
  if (framework === 'nuxt') return 'NUXT_PUBLIC_OPSLANE_API_KEY';
  return 'OPSLANE_API_KEY';
}

async function persistApiKeyEnvironment(cwd: string, framework: Framework, apiKey: string): Promise<void> {
  if (!apiKey.startsWith('opslane_pk_')) {
    throw new Error(
      'refusing to write a non-public key to .env.local: only opslane_pk_ keys belong in browser code',
    );
  }
  await writeEnvLocal(cwd, { [apiKeyEnvironmentVariable(framework)]: apiKey });
}

/**
 * Initialize Opslane in the current project.
 */
export async function init(options: InitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  console.log(chalk.bold('\nOpslane Init\n'));

  // Detect framework
  const framework = await detectFramework(cwd);
  console.log(
    `Detected framework: ${chalk.cyan(frameworkLabel(framework))}\n`,
  );

  // Get codemod or fallback
  const codemod = getCodemod(framework);
  let patches: FilePatch[];

  if (codemod) {
    console.log(chalk.dim(codemod.description));
    patches = await codemod.generate(cwd);
  } else {
    console.log(
      chalk.yellow(
        'No automatic codemod available. Generating template setup file.',
      ),
    );
    patches = await generateFallbackPatches(cwd);
  }

  // Show diff preview
  console.log(chalk.bold('\nChanges to apply:\n'));
  console.log(formatPatchPreview(patches));

  // Confirm with user
  if (!options.nonInteractive) {
    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Apply these changes?',
        default: true,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow('\nInit cancelled.'));
      return;
    }
  }

  // Apply patches
  await applyPatches(cwd, patches);
  console.log(chalk.green('\nPatches applied successfully!'));

  // Prompt for project ID
  let projectId = options.projectId;
  if (!projectId && !options.nonInteractive) {
    const answer = await inquirer.prompt<{ projectId: string }>([
      {
        type: 'input',
        name: 'projectId',
        message: 'Enter your Opslane project ID:',
      },
    ]);
    projectId = answer.projectId;
  }
  projectId = projectId ?? 'your-project-id';

  // Write .opslane.json config
  const config: Record<string, string> = {
    projectId,
    environment: 'production',
    framework,
  };

  await writeFile(
    join(cwd, '.opslane.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );

  if (options.apiKey) {
    await persistApiKeyEnvironment(cwd, framework, options.apiKey);
    console.log(chalk.green('Saved API key to git-ignored .env.local'));
  }

  console.log(chalk.green('Created .opslane.json'));
  console.log(chalk.bold('\nOpslane initialized successfully!'));
  console.log(
    chalk.dim('\nNext steps:'),
  );
  console.log(chalk.dim('  1. Run `opslane login` to authenticate'));
  console.log(chalk.dim('  2. Run `opslane doctor` to verify your setup'));
}

function frameworkLabel(framework: Framework): string {
  switch (framework) {
    case 'react-vite':
      return 'React + Vite';
    case 'nextjs':
      return 'Next.js';
    case 'vue-vite':
      return 'Vue + Vite';
    case 'nuxt':
      return 'Nuxt';
    case 'unknown':
      return 'Unknown';
  }
}
