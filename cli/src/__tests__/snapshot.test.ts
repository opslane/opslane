import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { writeFileAtomic } from '../fsutil.js';
import { restoreSnapshot, snapshotRegularFile } from '../onboard/snapshot.js';

async function fixture(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'opslane-snapshot-'));
  const file = join(root, 'vite.config.ts');
  writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]));
  chmodSync(file, 0o640);
  return { root, file };
}

describe('snapshotRegularFile and restoreSnapshot', () => {
  it('restores exact bytes and permissions after a rename replacement', async () => {
    const { root, file } = await fixture();
    const snapshot = snapshotRegularFile(root, 'vite.config.ts', 1024);
    const replacement = join(root, 'replacement');
    writeFileSync(replacement, 'changed\n');
    chmodSync(replacement, 0o600);
    renameSync(replacement, file);

    expect(restoreSnapshot(snapshot)).toBeUndefined();
    expect(readFileSync(file).equals(snapshot.contents)).toBe(true);
    expect(lstatSync(file).mode).toBe(snapshot.mode);
  });
});

describe('writeFileAtomic', () => {
  it('preserves an explicit mode and cleans its temporary file on success', async () => {
    const { root, file } = await fixture();
    await writeFileAtomic(file, 'next\n', 0o640);
    expect(readFileSync(file, 'utf8')).toBe('next\n');
    expect(lstatSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(root)).toEqual(['vite.config.ts']);
  });

  it('cleans its temporary file when replacement fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opslane-atomic-failure-'));
    const target = join(root, 'target');
    mkdirSync(target);
    await expect(writeFileAtomic(target, 'cannot replace a directory')).rejects.toThrow();
    expect(readdirSync(root)).toEqual(['target']);
    expect(lstatSync(target).isDirectory()).toBe(true);
  });
});
