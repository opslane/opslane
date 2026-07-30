import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
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
  let descriptor: number | undefined;
  try {
    const parentReal = realpathSync(path.dirname(snapshot.absolute));
    const rootReal = realpathSync(snapshot.root);
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + path.sep)) {
      throw new Error('parent directory escaped the repository');
    }
    const exists = existsSync(snapshot.absolute);
    const flags = exists
      ? constants.O_WRONLY | constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
    if (exists) {
      const current = lstatSync(snapshot.absolute);
      if (current.isSymbolicLink()) throw new Error('path became a symbolic link');
      if (!current.isFile() || current.nlink > 1) {
        throw new Error('path is no longer a regular unlinked file');
      }
    }
    descriptor = openSync(snapshot.absolute, flags, snapshot.mode);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink > 1) {
      throw new Error('opened path is no longer a regular unlinked file');
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, snapshot.contents);
    fchmodSync(descriptor, snapshot.mode);
    return undefined;
  } catch (error) {
    return `${snapshot.relative}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
