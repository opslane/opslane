/**
 * The single place a provisioned API key touches disk. Names come from the
 * agent's validated OnboardingPlan (tools.ts validatePlan); values come from
 * provisioning. Atomic write (fsutil), 0600 always.
 */
import { constants, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil.js';

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Read a file, refusing to traverse a final-component symlink. Missing is ''. */
async function readNoFollow(filePath: string): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    // ELOOP (Linux) / EMLINK (some BSDs) mean the final component is a symlink.
    throw new Error(`refusing to read ${filePath}: ${code}`);
  }
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function writeEnvLocal(
  dir: string,
  vars: Record<string, string>,
): Promise<string> {
  for (const name of Object.keys(vars)) {
    if (!ENV_VAR_NAME.test(name)) {
      throw new Error(`invalid environment variable name: ${JSON.stringify(name)}`);
    }
    if (/[\r\n]/.test(vars[name] ?? '')) {
      throw new Error(`invalid environment variable value for ${name}: line breaks are not allowed`);
    }
  }

  const envPath = join(dir, '.env.local');
  const gitignorePath = join(dir, '.gitignore');

  // Ignore the secret first, so a gitignore failure cannot leave it exposed.
  const gitignore = await readNoFollow(gitignorePath);
  if (!gitignore.split(/\r?\n/).includes('.env.local')) {
    await writeFileAtomic(
      gitignorePath,
      `${gitignore}${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}.env.local\n`,
    );
  }

  const current = await readNoFollow(envPath);
  let next = current;
  for (const [name, value] of Object.entries(vars)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    next = pattern.test(next)
      ? next.replace(pattern, line)
      : `${next}${next && !next.endsWith('\n') ? '\n' : ''}${line}\n`;
  }

  await writeFileAtomic(envPath, next);

  return envPath;
}
