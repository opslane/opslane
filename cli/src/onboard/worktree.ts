import { execFileSync } from 'node:child_process';

/**
 * Repo-relative paths with uncommitted changes, or null when `cwd` is not a git
 * repository. Onboarding edits the checkout in place, so anything already
 * modified gets mixed with our changes and cannot be cleanly separated later.
 */
export function uncommittedFiles(cwd: string): string[] | null {
  let output: string;
  try {
    // -z is required. Without it git quotes and escapes unusual paths, so a
    // filename with a space comes back wrapped in quotes.
    output = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return null;
  }

  const records = output.split('\0');
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    files.push(record.slice(3));
    // In -z mode a rename or copy emits its origin as the next record.
    if (/^[RC]/.test(record.slice(0, 2))) {
      index += 1;
      if (records[index]) files.push(records[index]);
    }
  }
  return files;
}
