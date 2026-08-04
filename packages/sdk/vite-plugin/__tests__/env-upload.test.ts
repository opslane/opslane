// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { opslaneVitePlugin } from '../index.js';

/**
 * The canary is the fixture's first valid vector, so the key the plugin reads
 * here is byte-identical to the one the server mints and both decoders pin.
 */
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../test-fixtures/sourcemap-key/vectors.json', import.meta.url),
    ),
    'utf8',
  ),
) as { valid: { endpoint: string; raw: string }[] };
const CANARY = vectors.valid[0]!;
/** Grammatically valid, but pre-cutover: no endpoint sealed in. */
const BARE_KEY =
  'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA';

const ENV_VARS = ['OPSLANE_SOURCEMAP_KEY', 'OPSLANE_ENDPOINT'] as const;
const priorEnv = new Map<string, string | undefined>();
const roots: string[] = [];

function isolateEnv(): void {
  for (const name of ENV_VARS) {
    priorEnv.set(name, process.env[name]);
    delete process.env[name];
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, value] of priorEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  priorEnv.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function projectWithEnvFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'opslane-vite-env-'));
  roots.push(root);
  writeFileSync(join(root, '.env.local'), contents);
  return root;
}

async function runBuild(root: string, logLevel: 'silent' | 'warn'): Promise<void> {
  const plugin = opslaneVitePlugin({ logLevel });
  (plugin.config as Function).call(plugin, {});
  await (plugin.configResolved as Function).call(plugin, {
    root,
    mode: 'production',
    build: { outDir: 'dist' },
    plugins: [{ name: 'opslane-debug-ids' }],
  });
  const bundle = {
    'assets/app.js': {
      type: 'chunk', fileName: 'assets/app.js', code: 'console.log("app")',
    },
    'assets/app.js.map': {
      type: 'asset', fileName: 'assets/app.js.map',
      source: JSON.stringify({
        version: 3,
        sources: ['src/app.ts'],
        sourcesContent: ['console.log("app")'],
        names: [],
        mappings: 'AAAA',
      }),
    },
  };
  const generate = plugin.generateBundle as {
    handler(options: unknown, output: unknown): Promise<void>;
  };
  await generate.handler.call(plugin, { format: 'es' }, bundle);
  await (plugin.closeBundle as Function).call(plugin);
}

it('loads the upload credential from the project .env.local and routes to its sealed URL', async () => {
  isolateEnv();
  const root = projectWithEnvFile(`OPSLANE_SOURCEMAP_KEY=${CANARY.raw}\n`);
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('', { status: 201 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await runBuild(root, 'silent');

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const url = String(fetchMock.mock.calls[0]?.[0]);
  // No endpoint variable anywhere: the destination came out of the key.
  expect(url.startsWith(`${CANARY.endpoint}/api/v1/sourcemaps/`)).toBe(true);
  expect(url).toMatch(/\/api\/v1\/sourcemaps\/[0-9a-f-]+$/);
  const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect((request.headers as Record<string, string>)['X-API-Key']).toBe(CANARY.raw);
});

it('refuses a pre-cutover bare key from .env.local and names the reason', async () => {
  isolateEnv();
  const root = projectWithEnvFile(`OPSLANE_SOURCEMAP_KEY=${BARE_KEY}\n`);
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await runBuild(root, 'warn');

  expect(fetchMock).not.toHaveBeenCalled();
  const warning = warn.mock.calls
    .map((call) => String(call[0]))
    .find((message) => message.includes('OPSLANE_VITE_KEY_INVALID'));
  expect(warning).toContain('legacy_format');
  // A warning is printed into build logs and pasted into issues: it must carry
  // the diagnosis and none of the credential.
  expect(warning).not.toContain(BARE_KEY);
  expect(warning).not.toContain('E2ESOURCEMAPSECRET');
});
