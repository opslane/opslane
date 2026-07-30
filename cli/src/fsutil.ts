import { randomBytes } from 'node:crypto';
import { open, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const LOCK_RETRY_MS = 20;
// Long enough to outwait a legitimate holder: token refresh runs under this
// lock and is itself bounded (see onboard/provision REFRESH_TIMEOUT_MS).
const LOCK_TIMEOUT_MS = 45_000;
// A lock older than this belongs to a process that died without releasing it.
// Kept above the longest legitimate hold and below LOCK_TIMEOUT_MS so a waiter
// reclaims the lock instead of giving up on it.
const LOCK_STALE_MS = 30_000;

export async function writeFileAtomic(
  filePath: string,
  contents: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const suffix = randomBytes(8).toString('hex');
  const tempPath = `${filePath}.${process.pid}.${suffix}.tmp`;
  const handle = await open(tempPath, 'wx', mode);
  try {
    try {
      if (typeof contents === 'string') {
        await handle.writeFile(contents, 'utf8');
      } else {
        await handle.writeFile(contents);
      }
      // Creation mode is filtered by umask. Restore the requested mode before
      // the rename so replacing a customer-owned config preserves permissions.
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function reclaimIfStale(lockPath: string): Promise<void> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) {
      await unlink(lockPath);
    }
  } catch {
    // Already gone, or not ours to reclaim. The retry loop handles both.
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || Date.now() >= deadline) {
        throw error;
      }
      // The release path is a `finally`, which a signal skips, so an
      // interrupted run can strand the lock and wedge every later write.
      // Reclaim one that is far older than any legitimate hold. Losing this
      // race just means another waiter took the lock first, and the retry
      // below sees it.
      await reclaimIfStale(lockPath);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}
