import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { containedRepoRelative, hasSecretSegment } from './paths.js';

export interface FileSnapshot {
  root: string;
  absolute: string;
  relative: string;
  contents: Buffer;
  mode: number;
}

export function snapshotRegularFile(
  root: string,
  relative: string,
  maxBytes: number,
): FileSnapshot {
  const canonical = containedRepoRelative(root, relative);
  if (canonical !== relative || hasSecretSegment(canonical)) {
    throw new Error(`unsafe plan path: ${relative}`);
  }
  const absolute = path.join(root, canonical);
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink > 1 || metadata.size > maxBytes) {
      throw new Error(`plan path is not a regular file: ${relative}`);
    }
    return {
      root,
      absolute,
      relative: canonical,
      contents: readFileSync(descriptor),
      mode: metadata.mode,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function restoreSnapshot(snapshot: FileSnapshot): string | undefined {
  const temporary = `${snapshot.absolute}.${process.pid}.${
    randomBytes(8).toString('hex')
  }.restore`;
  let descriptor: number | undefined;
  try {
    const parentReal = realpathSync(path.dirname(snapshot.absolute));
    const rootReal = realpathSync(snapshot.root);
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
      throw new Error('parent directory escaped the repository');
    }
    if (existsSync(snapshot.absolute)) {
      const current = lstatSync(snapshot.absolute);
      if (current.isSymbolicLink()) throw new Error('path became a symbolic link');
      if (!current.isFile() || current.nlink > 1) {
        throw new Error('path is no longer a regular unlinked file');
      }
    }
    // Write to a sibling and rename over the target. Truncating the real file
    // and then writing into it leaves the config empty if anything interrupts
    // the write, and at that moment the original bytes exist only in memory.
    // O_EXCL keeps this from following or reusing an attacker-planted path.
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      snapshot.mode,
    );
    writeFileSync(descriptor, snapshot.contents);
    // Creation mode is filtered by umask; restore the recorded mode exactly.
    fchmodSync(descriptor, snapshot.mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, snapshot.absolute);
    return undefined;
  } catch (error) {
    return `${snapshot.relative}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    // A successful rename consumed the temp file; anything left is debris.
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Leaving a stray temp file is strictly better than masking the real error.
    }
  }
}
