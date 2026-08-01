import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  installedPackageVersion,
  resolveViteConfig,
} from '../dist/codemods/vite-resolve.js';

interface CorpusEntry {
  appDir: string;
  configPath: string;
}

interface Failure {
  appDir: string;
  reason: string;
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  throw new Error(
    'usage: pnpm build && pnpm exec tsx scripts/measure-config-coverage.mts <corpus.json>',
  );
}

const manifestDirectory = resolve(manifestPath, '..');
const input = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
if (!Array.isArray(input)) throw new Error('corpus must be a JSON array');
const corpus: CorpusEntry[] = input.map((entry, index) => {
  if (
    !entry
    || typeof entry !== 'object'
    || typeof (entry as { appDir?: unknown }).appDir !== 'string'
    || typeof (entry as { configPath?: unknown }).configPath !== 'string'
  ) {
    throw new Error(`invalid corpus entry ${index}`);
  }
  const value = entry as CorpusEntry;
  const appDir = isAbsolute(value.appDir)
    ? value.appDir
    : resolve(manifestDirectory, value.appDir);
  const configPath = isAbsolute(value.configPath)
    ? value.configPath
    : join(appDir, value.configPath);
  return { appDir, configPath };
});

let loaded = 0;
let failedToLoad = 0;
let notInstalled = 0;
const failures: Failure[] = [];

for (const entry of corpus) {
  const viteVersion = await installedPackageVersion(entry.appDir, 'vite');
  if (!viteVersion) {
    notInstalled += 1;
    failures.push({
      appDir: entry.appDir,
      reason: 'not_installed',
    });
    continue;
  }
  if (!existsSync(entry.configPath)) {
    failedToLoad += 1;
    failures.push({
      appDir: entry.appDir,
      reason: 'config_not_found',
    });
    continue;
  }

  const isolatedHome = await mkdtemp(join(tmpdir(), 'opslane-vite-measure-'));
  try {
    const result = await resolveViteConfig({
      appDir: entry.appDir,
      configPath: entry.configPath,
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      },
    });
    if (result.ok) {
      loaded += 1;
    } else {
      failedToLoad += 1;
      failures.push({
        appDir: entry.appDir,
        reason: result.error ? `${result.reason}: ${result.error}` : result.reason,
      });
    }
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  total: corpus.length,
  loaded,
  failedToLoad,
  notInstalled,
  failures,
}, null, 2));
