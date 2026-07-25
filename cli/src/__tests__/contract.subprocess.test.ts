import { spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const cliRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliEntry = join(cliRoot, 'dist', 'index.js');
const pollId = '123e4567-e89b-42d3-a456-426614174000';

interface RunResult { code: number; stdout: string; stderr: string }

function runCli(args: string[], home: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing server address'));
      resolve(address.port);
    });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('compiled CLI agent contract', () => {
  const temporaryDirectories: string[] = [];
  // Compiles the whole CLI before the subprocess contract tests. This grows with
  // the codebase and runs cold on CI, so the default 10s hook timeout is too tight
  // (it timed out on CI once the Apply stage was added). Give it a real budget.
  beforeAll(() => execFileSync('pnpm', ['exec', 'tsc'], { cwd: cliRoot, stdio: 'pipe' }), 120_000);
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function temp(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'opslane-contract-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  async function startThenPoll(
    pollBody: Record<string, unknown>,
    pollStatus = 200,
  ): Promise<{ start: RunResult; poll: RunResult; pollTokenSeen: string | undefined }> {
    let pollTokenSeen: string | undefined;
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') {
        response.statusCode = 201;
        response.end(JSON.stringify({
          status: 'auth_required', auth_url: 'https://github.test/install',
          poll_id: pollId, poll_token: 'subprocess-secret', message: 'authorize',
        }));
        return;
      }
      pollTokenSeen = request.headers['x-opslane-poll-token'] as string | undefined;
      response.statusCode = pollStatus;
      response.end(JSON.stringify(pollBody));
    });
    const port = await listen(server);
    const home = await temp();
    const cwd = await temp();
    const common = ['--repo', 'acme/app', '--api-url', `http://127.0.0.1:${port}`];
    try {
      const start = await runCli(['setup', '--start', ...common], home, cwd);
      const poll = await runCli(['setup', '--poll', pollId, '--timeout', '1'], home, cwd);
      return { start, poll, pollTokenSeen };
    } finally {
      await close(server);
    }
  }

  it('prints one JSON document for --start and sends the poll token on completion', async () => {
    const result = await startThenPoll({
      status: 'completed', org_id: 'org', project_id: 'project', api_key: 'key', repo: 'acme/app',
    });
    expect(result.start.code).toBe(0);
    expect(JSON.parse(result.start.stdout)).toMatchObject({ status: 'auth_required', poll_id: pollId });
    expect(result.poll.code).toBe(0);
    expect(JSON.parse(result.poll.stdout)).toMatchObject({ status: 'completed', api_key: 'key' });
    expect(result.pollTokenSeen).toBe('subprocess-secret');
  });

  it.each([
    [{ status: 'completed', project_id: 'project' }, 200, 'key_unavailable'],
    [{ status: 'failed', failure_reason: 'repo_not_granted', message: 'grant repo' }, 200, 'failed'],
    [{ status: 'expired' }, 410, 'expired'],
    [{ status: 'not_found' }, 404, 'not_found'],
  ] as const)('maps terminal poll body %j', async (body, httpStatus, expectedStatus) => {
    const result = await startThenPoll(body, httpStatus);
    expect(result.poll.code).toBe(1);
    expect(JSON.parse(result.poll.stdout)).toMatchObject({ status: expectedStatus });
  });

  it('reports conflicting setup modes as one usage_error JSON document', async () => {
    const home = await temp();
    const cwd = await temp();
    const result = await runCli(['setup', '--start', '--poll', pollId, '--repo', 'acme/app'], home, cwd);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'usage_error' });
  });

  it('onboard emits one tty_required JSON document when not a TTY', async () => {
    const result = await runCli(['onboard'], await temp(), await temp());
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'tty_required' });
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  it.each([
    ['setup', '--start', '--repo', 'acme/app'],
    ['snippet', '--api-key', 'test-key'],
    ['verify'],
    ['status'],
    ['errors', 'list'],
  ])('%s reports an invalid API URL as one usage_error document', async (...args) => {
    const home = await temp();
    const cwd = await temp();
    const result = await runCli([...args, '--api-url', 'file:///tmp/opslane'], home, cwd);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'usage_error' });
    expect(result.stderr).toBe('');
  });
});
