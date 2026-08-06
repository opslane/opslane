import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCase } from './loader.js';
import { runInvestigationCase } from './investigation-runner.js';

const EVAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(args: string[], name: string): string | undefined {
  const exactIndex = args.indexOf(name);
  if (exactIndex >= 0) return args[exactIndex + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoPath = option(args, '--repo');
  if (!repoPath) throw new Error('--repo is required');

  const trialsText = option(args, '--trials') ?? '6';
  const trials = Number(trialsText);
  if (!Number.isInteger(trials) || trials < 1) {
    throw new Error(`--trials must be a positive integer, got ${JSON.stringify(trialsText)}`);
  }

  const surfaceText = option(args, '--surface');
  const surface = {
    globs: surfaceText
      ? surfaceText.split(',').map((glob) => glob.trim()).filter(Boolean)
      : null,
  };
  const casesDir = path.join(EVAL_ROOT, 'cases');
  const entries = await readdir(casesDir, { withFileTypes: true });
  const hardCases = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('hard-'))
    .map((entry) => entry.name)
    .sort();

  console.log('id | expected | passes/trials | cause_location per trial');
  for (const caseName of hardCases) {
    const evalCase = await loadCase(path.join(casesDir, caseName));
    const result = await runInvestigationCase(evalCase, repoPath, surface, trials);
    console.log(
      `${result.id} | ${result.expected} | ${result.passes}/${result.trials} | ` +
      result.causeLocations.map((location) => location ?? '(none)').join(' ; '),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
