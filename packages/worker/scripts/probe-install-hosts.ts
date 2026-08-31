import { readFile } from 'node:fs/promises';
import { ALL_TRAFFIC, CommandExitError, Sandbox } from 'e2b';
import pg from 'pg';
import { buildGitNetrc } from '../src/repo-url.js';

const TEMPLATE = process.env['OPSLANE_E2B_JAVASCRIPT_TEMPLATE']?.trim();
const TOKENS_FILE = process.env['PROBE_GITHUB_TOKENS_FILE']?.trim();
const DATABASE_URL = process.env['DATABASE_URL']?.trim();
if (!TEMPLATE) throw new Error('OPSLANE_E2B_JAVASCRIPT_TEMPLATE is required');
if (!TOKENS_FILE) throw new Error('PROBE_GITHUB_TOKENS_FILE is required');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const DEFAULT_HOSTS = [
  'registry.npmjs.org', 'nodejs.org', 'github.com', 'codeload.github.com',
  'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
];
const candidateHosts = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_HOSTS;
const REPO = '/home/user/repo';

interface RepositoryRow { github_repo: string; github_installation_id: string | null }
interface Outcome { ok: boolean; detail: string; sha?: string }

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function tokens(): Promise<Record<string, string>> {
  const parsed: unknown = JSON.parse(await readFile(TOKENS_FILE!, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('PROBE_GITHUB_TOKENS_FILE must contain an object keyed by installation id');
  }
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[1].length > 0));
}

async function run(repo: string, token: string, restricted: boolean, sha?: string): Promise<Outcome> {
  const repoUrl = new URL(`${repo}.git`, 'https://github.com/').toString();
  const sbx = await Sandbox.create(TEMPLATE!, {
    timeoutMs: 600_000,
    ...(restricted ? { network: { denyOut: [ALL_TRAFFIC], allowOut: candidateHosts, rules: {} } } : {}),
  });
  try {
    const netrc = buildGitNetrc(repoUrl, token);
    if (!netrc) return { ok: false, detail: 'clone URL did not support netrc authentication' };
    await sbx.files.write('/home/user/.netrc', netrc);
    await sbx.commands.run('chmod 600 /home/user/.netrc');
    await sbx.commands.run(`git clone --depth 1 -- ${quote(repoUrl)} ${REPO}`, { timeoutMs: 120_000 });
    if (sha) {
      await sbx.commands.run(`cd ${REPO} && git fetch --depth 1 origin ${quote(sha)} && git checkout ${quote(sha)}`,
        { timeoutMs: 120_000 });
    }
    const resolved = (await sbx.commands.run(`cd ${REPO} && git rev-parse HEAD`)).stdout.trim();
    await sbx.commands.run('rm -f /home/user/.netrc && test ! -e /home/user/.netrc');
    const install = 'if [ -f pnpm-lock.yaml ]; then pnpm install; elif [ -f yarn.lock ]; then yarn install; else npm install; fi';
    await sbx.commands.run(`cd ${REPO} && ${install}`, { timeoutMs: 300_000 });
    return { ok: true, detail: 'installed', sha: resolved };
  } catch (error: unknown) {
    // Never print raw logs: they can contain repository names, package scripts,
    // signed URLs, or credentials echoed by customer-controlled install code.
    const detail = error instanceof CommandExitError
      ? `${error.stderr}\n${error.stdout}`
      : error instanceof Error ? error.message : String(error);
    const host = /(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i.exec(detail)?.[1];
    return { ok: false, detail: host ? `failed; named host ${host}` : 'failed; no host named' };
  } finally {
    await sbx.kill().catch(() => undefined);
  }
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });
try {
  const { rows } = await pool.query<RepositoryRow>(
    `SELECT DISTINCT p.github_repo, o.github_installation_id::text
       FROM projects p
       JOIN orgs o ON o.id = p.org_id
      WHERE p.github_repo <> ''
        AND EXISTS (
          SELECT 1 FROM error_groups g
           WHERE g.project_id = p.id AND COALESCE(g.platform, 'javascript') = 'javascript'
        )
      ORDER BY p.github_repo`,
  );
  console.log('| Repository | Baseline | Restricted |');
  console.log('| --- | --- | --- |');
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const installation = row.github_installation_id;
    const token = installation ? (await tokens())[installation] : undefined;
    if (!token) {
      console.log(`| repo-${index + 1} | unprobed (token unavailable) | unprobed |`);
      continue;
    }
    const baseline = await run(row.github_repo, token, false);
    const restricted = baseline.ok && baseline.sha
      ? await run(row.github_repo, token, true, baseline.sha)
      : { ok: false, detail: 'not counted; baseline failed' };
    console.log(`| repo-${index + 1} | ${baseline.detail} | ${restricted.detail} |`);
  }
} finally {
  await pool.end();
}
