import { execFile as execFileCallback } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export const execFile = promisify(execFileCallback);
export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Reliability Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@opslane.test',
  GIT_COMMITTER_NAME: 'Reliability Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@opslane.test',
};

export interface RecordedRequest {
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
}

export interface FixtureRepository {
  remote: string;
  deliveryClone: string;
}

/** A pull request held by the GitHub twin, created by the real worker. */
export interface TwinPullRequest {
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export interface ProviderTwinOptions {
  /** Ingestion base URL that receives signed pull_request webhooks on merge/close. */
  ingestionUrl?: string;
  /** Shared HMAC secret — must equal ingestion's GITHUB_WEBHOOK_SECRET. */
  webhookSecret?: string;
}

export interface ProviderRecorders {
  anthropicBaseUrl: string;
  githubBaseUrl: string;
  anthropicJournal: RecordedRequest[];
  githubJournal: RecordedRequest[];
  /** PRs the worker created against the GitHub twin, in creation order. */
  pullRequests: TwinPullRequest[];
  /** Merge a twin PR and deliver the signed pull_request webhook to ingestion. */
  mergePullRequest(number: number, closedAt?: Date): Promise<Response>;
  /** Close a twin PR unmerged and deliver the signed webhook to ingestion. */
  closePullRequest(number: number, closedAt?: Date): Promise<Response>;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recorder did not bind to TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function anthropicMessage(
  body: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
  stopReason: 'tool_use' | 'end_turn',
): Record<string, unknown> {
  return {
    id: `msg_fixture_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: body['model'],
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

export function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body['tools']) ? body['tools'] : [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return [];
    const name = (tool as Record<string, unknown>)['name'];
    return typeof name === 'string' ? [name] : [];
  });
}

function toolResultCount(body: Record<string, unknown>): number {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  let count = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    count += content.filter((block) => (
      block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_result'
    )).length;
  }
  return count;
}

export async function createFixtureRepository(
  root: string,
  remote: string = join(root, 'fixture.git'),
): Promise<FixtureRepository> {
  const seed = join(root, 'seed');
  const deliveryClone = join(root, 'delivery');
  await mkdir(join(seed, 'src'), { recursive: true });
  await mkdir(join(seed, 'test'), { recursive: true });
  await mkdir(dirname(remote), { recursive: true });
  await writeFile(join(seed, 'package.json'), JSON.stringify({
    name: 'opslane-reliability-fixture',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2));
  await writeFile(
    join(seed, 'src', 'value.js'),
    "export function value(input) { return input.value.toUpperCase(); }\n",
  );
  await writeFile(
    join(seed, 'test', 'value.test.js'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.js';",
      '',
      "test('handles missing production data', () => {",
      "  assert.equal(value(null), 'UNKNOWN');",
      '});',
      '',
    ].join('\n'),
  );
  await execFile('git', ['init', '--initial-branch=main'], { cwd: seed, env: GIT_ENV });
  await execFile('git', ['add', '-A'], { cwd: seed, env: GIT_ENV });
  await execFile('git', ['commit', '-m', 'seed failing fixture'], { cwd: seed, env: GIT_ENV });
  await execFile('git', ['clone', '--bare', seed, remote], { env: GIT_ENV });
  await execFile('git', ['clone', remote, deliveryClone], { env: GIT_ENV });
  return { remote, deliveryClone };
}

export async function startProviderRecorders(options: ProviderTwinOptions = {}): Promise<ProviderRecorders> {
  const anthropicJournal: RecordedRequest[] = [];
  const anthropicServer = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    anthropicJournal.push({
      path: request.url ?? '',
      authorization: request.headers['x-api-key'] as string | undefined,
      body,
    });
    const names = toolNames(body);
    let message: Record<string, unknown>;
    if (names.includes('classify_friction')) {
      message = anthropicMessage(body, [{
        type: 'tool_use',
        id: 'tool_classify_friction',
        name: 'classify_friction',
        input: {
          codeCause: true,
          confidence: 'high',
          reason: 'The value renderer dereferences missing input, so the control appears dead.',
          remediation: 'Guard the missing value with a narrow fallback.',
        },
      }], 'tool_use');
    } else if (names.includes('submit_diagnosis') && !names.includes('edit')) {
      // The investigation's terminal tool, which replaced classify_error when
      // the two-agent split was retired. Without a branch here the request fell
      // through to the prose reply below, the loop nudged once, gave up, and the
      // whole pipeline terminated needs_human — which is what this lane caught.
      //
      // The `edit` exclusion is load-bearing, and it is a real hazard rather
      // than a quirk of this twin: the FIX agent declares a decline tool that is
      // also called submit_diagnosis (harness/tool-bridge.ts) with an
      // incompatible schema. Matching on the name alone answered the fix agent
      // with an investigation-shaped diagnosis, which it read as "the agent gave
      // up" — needs_human, at the last step of the pipeline. Only the
      // investigation lacks `edit`, so that is what tells the two apart.
      message = anthropicMessage(body, [{
        type: 'tool_use',
        id: 'tool_diagnose',
        name: 'submit_diagnosis',
        input: {
          best_supported: 'A nullable production value is dereferenced without a guard.',
          evidence_check: 'Read src/value.js and the failing test.',
          candidates_considered: [
            { statement: 'The value renderer dereferences a nullable input', kind: 'local_code' },
            { statement: 'The upstream service returned an unexpected payload', kind: 'external_system' },
          ],
          rejected: ['The upstream service returned an unexpected payload — the crash reproduces offline.'],
          evidence_strength: 'conclusive',
          cause_kind: 'local_code',
          // Must resolve inside the fixture clone, or routing scores it
          // citation_unresolvable and parks the incident.
          cause_locations: [{ path: 'src/value.js', line: 1, note: 'Dereferenced before any guard.' }],
          reasoning: 'The stack names src/value.js, and the value is read before it is checked.',
          why_chain: ['Production data contains null', 'value is dereferenced', 'Rendering throws'],
          reproduction_steps: ['Render the fixture with a null value'],
        },
      }], 'tool_use');
    } else if (names.includes('score_diff')) {
      message = anthropicMessage(body, [{
        type: 'tool_use',
        id: 'tool_judge',
        name: 'score_diff',
        input: {
          scope: 2,
          correctness: 2,
          preservation: 2,
          explanation: 'The change is minimal and covers the failing null input.',
        },
      }], 'tool_use');
    } else if (names.includes('submit_fix_narrative')) {
      message = anthropicMessage(body, [{
        type: 'tool_use',
        id: 'tool_fix_narrative',
        name: 'submit_fix_narrative',
        input: {
          subject: 'Guard missing values in value',
          whatHappened: 'Rendering a record with missing data crashed the page.',
          whyItBroke: 'The value function dereferenced nullable input before checking it.',
          fixApproach: 'Render a narrow fallback when the value is absent.',
        },
      }], 'tool_use');
    } else if (names.includes('edit')) {
      const results = toolResultCount(body);
      if (results === 0) {
        message = anthropicMessage(body, [{
          type: 'tool_use',
          id: 'tool_edit',
          name: 'edit',
          input: {
            path: '/home/user/repo/src/value.js',
            old_string: 'input.value.toUpperCase()',
            new_string: "input?.value?.toUpperCase() ?? 'UNKNOWN'",
          },
        }], 'tool_use');
      } else if (results === 1) {
        message = anthropicMessage(body, [{
          type: 'tool_use',
          id: 'tool_test',
          name: 'bash',
          input: { command: 'cd /home/user/repo && npm test -- --test-reporter=dot' },
        }], 'tool_use');
      } else {
        message = anthropicMessage(body, [{
          type: 'text',
          text: 'The null input was dereferenced before validation. The fix adds a narrow fallback and the test passes.',
        }], 'end_turn');
      }
    } else {
      message = anthropicMessage(body, [{
        type: 'text',
        text: 'A user encountered missing data. The page crashed while reading it. This change safely renders a fallback value.',
      }], 'end_turn');
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
  });
  const anthropicBaseUrl = await listen(anthropicServer);

  const githubJournal: RecordedRequest[] = [];
  const pullRequests: TwinPullRequest[] = [];
  let nextPullNumber = 42;
  const githubServer = createServer(async (request, response) => {
    const body = await readJsonRequest(request);
    githubJournal.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      body,
    });
    // Stateful slice of GitHub's REST API: pulls.create. Response shape from
    // GitHub's spec — the twin remembers the PR so a later merge/close can
    // deliver the matching webhook.
    const pullsMatch = /^\/repos\/([^/]+)\/([^/?]+)\/pulls(?:\?.*)?$/.exec(request.url ?? '');
    if (request.method === 'GET' && pullsMatch) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([]));
      return;
    }
    if (request.method === 'POST' && pullsMatch) {
      const pull: TwinPullRequest = {
        number: nextPullNumber++,
        owner: pullsMatch[1]!,
        repo: pullsMatch[2]!,
        title: String(body['title'] ?? ''),
        body: String(body['body'] ?? ''),
        head: String(body['head'] ?? ''),
        base: String(body['base'] ?? ''),
        state: 'open',
        merged: false,
      };
      pullRequests.push(pull);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        html_url: `https://github.test/${pull.owner}/${pull.repo}/pull/${pull.number}`,
        number: pull.number,
        state: pull.state,
        title: pull.title,
      }));
      return;
    }
    // Anything else the worker probes (e.g. repo contents) is absent.
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'Not Found' }));
  });
  const githubBaseUrl = await listen(githubServer);

  // Deliver a spec-shaped, HMAC-signed pull_request webhook, exactly as GitHub
  // would. Shapes come from GitHub's webhook spec, not from what ingestion
  // expects — that's what makes the twin catch bugs instead of confirming them.
  async function deliverClosed(pull: TwinPullRequest, merged: boolean, closedAt: Date): Promise<Response> {
    const { ingestionUrl, webhookSecret } = options;
    if (!ingestionUrl || !webhookSecret) {
      throw new Error('GitHub twin webhooks need ingestionUrl + webhookSecret in startProviderRecorders options');
    }
    pull.state = 'closed';
    pull.merged = merged;
    const payload = JSON.stringify({
      action: 'closed',
      number: pull.number,
      pull_request: {
        number: pull.number,
        state: 'closed',
        title: pull.title,
        merged,
        merged_at: merged ? closedAt.toISOString() : null,
        closed_at: closedAt.toISOString(),
        head: { ref: pull.head },
        base: { ref: pull.base },
      },
      repository: {
        full_name: `${pull.owner}/${pull.repo}`,
        name: pull.repo,
        owner: { login: pull.owner },
      },
    });
    const signature = createHmac('sha256', webhookSecret).update(payload).digest('hex');
    return fetch(`${ingestionUrl.replace(/\/$/, '')}/api/v1/github/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
        'x-github-event': 'pull_request',
        'x-github-delivery': randomUUID(),
      },
      body: payload,
    });
  }

  function findPull(number: number): TwinPullRequest {
    const pull = pullRequests.find((candidate) => candidate.number === number);
    if (!pull) throw new Error(`GitHub twin has no pull request #${number}`);
    return pull;
  }

  return {
    anthropicBaseUrl,
    githubBaseUrl,
    anthropicJournal,
    githubJournal,
    pullRequests,
    mergePullRequest: (number, closedAt = new Date()) => deliverClosed(findPull(number), true, closedAt),
    closePullRequest: (number, closedAt = new Date()) => deliverClosed(findPull(number), false, closedAt),
    close: async () => Promise.all([close(anthropicServer), close(githubServer)]).then(() => undefined),
  };
}
