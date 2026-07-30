import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type ViteResolveFailureReason =
  | 'vite_not_installed'
  | 'vite_version_unsupported'
  | 'vite_not_usable'
  | 'vite_config_failed'
  | 'vite_resolve_timeout'
  | 'vite_resolve_child_failed';

export type ViteResolveResult =
  | { ok: true; pluginNames: string[] }
  | { ok: false; reason: ViteResolveFailureReason; error?: string };

export interface ResolveInChildOptions {
  appDir: string;
  configPath: string;
  /** Test seam for source-level tests; never sent over IPC. */
  resolvePackage?: (specifier: string) => string;
}

export interface ResolveOptions extends ResolveInChildOptions {
  childEntry?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

const MAX_ERROR_LENGTH = 8_000;

function cleanError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .slice(0, MAX_ERROR_LENGTH);
}

function majorVersion(version: string): number | null {
  const match = version.match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const upper = key.toUpperCase();
      return !upper.startsWith('OPSLANE_')
        && !upper.startsWith('ANTHROPIC_')
        && !upper.startsWith('GITHUB_')
        && !upper.startsWith('AWS_')
        && upper !== 'NPM_TOKEN';
    }),
  );
}

export async function installedPackageVersion(
  appDir: string,
  packageName: string,
  resolvePackage?: (specifier: string) => string,
): Promise<string | null> {
  let manifestPath: string | undefined;
  try {
    const request = createRequire(join(appDir, 'package.json'));
    manifestPath = (resolvePackage ?? request.resolve)(`${packageName}/package.json`);
  } catch {
    // Some packages export their runtime entry but deliberately do not export
    // package.json. Follow Node's ancestor node_modules lookup for the manifest
    // without importing package code.
    let current = appDir;
    const filesystemRoot = parse(current).root;
    while (true) {
      const candidate = join(current, 'node_modules', packageName, 'package.json');
      if (existsSync(candidate)) {
        manifestPath = candidate;
        break;
      }
      if (current === filesystemRoot) break;
      current = dirname(current);
    }
  }
  if (!manifestPath) return null;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function resolveInChild(
  options: ResolveInChildOptions,
): Promise<ViteResolveResult> {
  const request = createRequire(join(options.appDir, 'package.json'));
  const resolvePackage = options.resolvePackage ?? request.resolve;
  const viteVersion = await installedPackageVersion(
    options.appDir,
    'vite',
    resolvePackage,
  );
  if (!viteVersion) return { ok: false, reason: 'vite_not_installed' };
  const major = majorVersion(viteVersion);
  if (major === null || major < 6) {
    return { ok: false, reason: 'vite_version_unsupported' };
  }

  try {
    const viteModule = await import(pathToFileURL(resolvePackage('vite')).href);
    const fallback = viteModule.default as { resolveConfig?: unknown } | undefined;
    const resolveConfig = viteModule.resolveConfig ?? fallback?.resolveConfig;
    if (typeof resolveConfig !== 'function') {
      return { ok: false, reason: 'vite_not_usable' };
    }
    const resolved = await resolveConfig(
      { root: options.appDir, configFile: options.configPath },
      'build',
    ) as { plugins?: Array<{ name?: unknown }> };
    const pluginNames = Array.isArray(resolved.plugins)
      ? resolved.plugins.flatMap((plugin) =>
          typeof plugin?.name === 'string' ? [plugin.name] : [],
        )
      : [];
    return { ok: true, pluginNames };
  } catch (error) {
    return { ok: false, reason: 'vite_config_failed', error: cleanError(error) };
  }
}

const FAILURE_REASONS = new Set<ViteResolveFailureReason>([
  'vite_not_installed',
  'vite_version_unsupported',
  'vite_not_usable',
  'vite_config_failed',
  'vite_resolve_timeout',
  'vite_resolve_child_failed',
]);

interface ChildEnvelope {
  type: 'vite-resolve-result';
  requestId: string;
  result: ViteResolveResult;
}

function validChildEnvelope(message: unknown, requestId: string): message is ChildEnvelope {
  if (
    !message
    || typeof message !== 'object'
    || (message as { type?: unknown }).type !== 'vite-resolve-result'
    || (message as { requestId?: unknown }).requestId !== requestId
  ) return false;
  const result = (message as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || !('ok' in result)) return false;
  if ((result as { ok: unknown }).ok === true) {
    const names = (result as { pluginNames?: unknown }).pluginNames;
    return Array.isArray(names)
      && names.every(
        (name) => typeof name === 'string',
      );
  }
  const reason = (result as { reason?: unknown }).reason;
  return (result as { ok?: unknown }).ok === false
    && typeof reason === 'string'
    && FAILURE_REASONS.has(reason as ViteResolveFailureReason);
}

export async function resolveViteConfig(options: ResolveOptions): Promise<ViteResolveResult> {
  const childEntry = options.childEntry
    ?? fileURLToPath(new URL('./vite-resolve-child.js', import.meta.url));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const killGraceMs = options.killGraceMs ?? 250;
  const requestId = randomUUID();

  return await new Promise<ViteResolveResult>((resolve) => {
    const child = fork(childEntry, [], {
      cwd: options.appDir,
      env: sanitizeChildEnv(options.env ?? process.env),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let result: ViteResolveResult | undefined;
    let timedOut = false;
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_ERROR_LENGTH);
    });
    child.on('message', (message) => {
      if (!result && validChildEnvelope(message, requestId)) result = message.result;
    });
    child.on('error', (error) => {
      if (!result) {
        result = {
          ok: false,
          reason: 'vite_resolve_child_failed',
          error: cleanError(error),
        };
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        resolve({ ok: false, reason: 'vite_resolve_timeout' });
      } else if (result) {
        resolve(result);
      } else {
        resolve({
          ok: false,
          reason: 'vite_resolve_child_failed',
          ...(stderr ? { error: cleanError(stderr) } : {}),
        });
      }
    });

    child.send({
      type: 'vite-resolve-request',
      requestId,
      appDir: options.appDir,
      configPath: options.configPath,
    });
  });
}
