import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeEnvLocal } from '../envfile.js';

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'opslane-env-'));
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe('writeEnvLocal', () => {
  it('creates .env.local with mode 0600 and returns the path', async () => {
    const d = await dir();
    const path = await writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'opk_1' });
    expect(path).toBe(join(d, '.env.local'));
    expect(await readFile(path, 'utf8')).toBe('VITE_OPSLANE_API_KEY=opk_1\n');
    expect(await mode(path)).toBe(0o600);
  });

  it('appends missing keys without touching existing lines', async () => {
    const d = await dir();
    await writeFile(join(d, '.env.local'), 'EXISTING=1\n');
    await writeEnvLocal(d, { VITE_OPSLANE_ENDPOINT: 'http://x' });
    expect(await readFile(join(d, '.env.local'), 'utf8'))
      .toBe('EXISTING=1\nVITE_OPSLANE_ENDPOINT=http://x\n');
  });

  it('replaces an existing value for the same key', async () => {
    const d = await dir();
    await writeFile(join(d, '.env.local'), 'VITE_OPSLANE_API_KEY=old\nOTHER=2\n');
    await writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'new' });
    expect(await readFile(join(d, '.env.local'), 'utf8'))
      .toBe('VITE_OPSLANE_API_KEY=new\nOTHER=2\n');
  });

  it('tightens a pre-existing 0644 file to 0600', async () => {
    const d = await dir();
    const path = join(d, '.env.local');
    await writeFile(path, 'A=1\n');
    await chmod(path, 0o644);
    await writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'k' });
    expect(await mode(path)).toBe(0o600);
  });

  it('adds .env.local to the dir gitignore exactly once', async () => {
    const d = await dir();
    await writeEnvLocal(d, { A_B: '1' });
    await writeEnvLocal(d, { A_B: '2' });
    const lines = (await readFile(join(d, '.gitignore'), 'utf8'))
      .split('\n')
      .filter((line) => line === '.env.local');
    expect(lines).toHaveLength(1);
  });

  it('refuses to write through a symlinked .gitignore', async () => {
    const d = await dir();
    const outside = join(await mkdtemp(join(tmpdir(), 'opslane-out-')), 'victim');
    await writeFile(outside, 'original\n');
    await symlink(outside, join(d, '.gitignore'));

    await expect(writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'opk_x' })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('original\n');
  });

  it('refuses to write through a symlinked .env.local', async () => {
    const d = await dir();
    const outside = join(await mkdtemp(join(tmpdir(), 'opslane-out-')), 'victim');
    await writeFile(outside, 'original\n');
    await symlink(outside, join(d, '.env.local'));

    await expect(writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'opk_x' })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('original\n');
  });

  it('does not leave the key on disk when the gitignore write fails', async () => {
    const d = await dir();
    await mkdir(join(d, '.gitignore'));

    await expect(writeEnvLocal(d, { VITE_OPSLANE_API_KEY: 'opk_x' })).rejects.toThrow();
    await expect(readFile(join(d, '.env.local'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects var names failing the regex', async () => {
    const d = await dir();
    await expect(writeEnvLocal(d, { lower_case: 'x' }))
      .rejects.toThrow(/variable name/);
    await expect(writeEnvLocal(d, { 'A=B\nINJECTED': 'x' }))
      .rejects.toThrow(/variable name/);
  });

  it('rejects values that could inject another dotenv line', async () => {
    const d = await dir();
    await expect(writeEnvLocal(d, {
      VITE_OPSLANE_ENDPOINT: 'http://localhost\nINJECTED=1',
    })).rejects.toThrow(/line breaks/);
  });
});

describe('writeEnvLocal refuses secrets', () => {
  it('writes a public ingest key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'envfile-pk-'));
    await writeEnvLocal(dir, {
      VITE_OPSLANE_API_KEY:
        'opslane_pk_mzxw6ytboi3damrrgi3tknzxgq_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_ab',
    });
    const body = await readFile(join(dir, '.env.local'), 'utf8');
    expect(body).toContain('opslane_pk_');
  });

  it('refuses a source-map secret key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'envfile-sk-'));
    await expect(writeEnvLocal(dir, {
      VITE_OPSLANE_API_KEY:
        'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_ab',
    })).rejects.toThrow(/only opslane_pk_ keys belong in browser code/);
  });

  it('refuses an endpoint-bearing source-map secret key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'envfile-sk-payload-'));
    // vectors.valid[0].raw from test-fixtures/sourcemap-key/vectors.json: the
    // refusal keys off the prefix, so the trailing payload changes nothing.
    await expect(writeEnvLocal(dir, {
      VITE_OPSLANE_API_KEY:
        'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_E2ESOURCEMAPSECRETAAAAAAAAAAAAAAAAAAAAAAAAA'
        + '_eyJ2IjoxLCJpYXQiOiIyMDI2LTA4LTA0VDAwOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vaW5nZXN0Lm9wc2xhbmUuY29tIn0',
    })).rejects.toThrow(/only opslane_pk_ keys belong in browser code/);
    await expect(readFile(join(dir, '.env.local'), 'utf8')).rejects.toThrow();
  });

  it('leaves no .env.local behind when it refuses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'envfile-none-'));
    await expect(writeEnvLocal(dir, {
      VITE_OPSLANE_API_KEY:
        'opslane_sk_mzxw6ytboi3damrrgi3tknzxgq_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789-_ab',
    })).rejects.toThrow();
    await expect(readFile(join(dir, '.env.local'), 'utf8')).rejects.toThrow();
  });
});
