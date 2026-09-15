import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Go integration test packages share a Postgres in CI, and several call
// sweepers that are not scoped to a project (priority, retention) and rewrite
// other packages' fixtures. Test cases inside a package run sequentially, so
// what keeps packages from interfering is that no two run at once against one
// database: the slow db package has its own matrix shard (and its own Postgres
// service), and the rest shard runs with `-p 1`. The per-package -timeout must
// stay positive and shorter than the job timeout, so a stuck package usually
// prints goroutine stacks before the job is killed.
const lines = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n');

/** Lines of one top-level job, from `  <id>:` up to the next job. */
function jobLines(id) {
  const start = lines.indexOf(`  ${id}:`);
  assert.notEqual(start, -1, `job \`${id}\` not found in ci.yml`);
  // Same job-id pattern as workflowJobs in check-ci-ok.test.mjs.
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z_][A-Za-z0-9_-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end);
}

/** Non-blank, non-comment lines of a step's `run: |` block, found by step name. */
function runCommands(job, stepName) {
  const step = job.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(step, -1, `step \`${stepName}\` not found`);
  const run = job.findIndex((line, i) => i > step && line.trim() === 'run: |');
  assert.notEqual(run, -1, `step \`${stepName}\` has no \`run: |\` block`);
  const indent = job[run].search(/\S/);
  const body = [];
  for (const line of job.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line.trim());
  }
  return body.filter((line) => line !== '' && !line.startsWith('#'));
}

/** Values of a flag given as `-name value` or `-name=value` (one or two dashes). */
function flagValues(tokens, name) {
  const values = [];
  tokens.forEach((token, i) => {
    if (token === `-${name}` || token === `--${name}`) values.push(tokens[i + 1]);
    else if (token.startsWith(`-${name}=`) || token.startsWith(`--${name}=`)) values.push(token.split('=')[1]);
  });
  return values;
}

const go = jobLines('go');
const commands = runCommands(go, 'Test (fails on unexpected skips)');
const goTests = commands.filter((line) => /^go test\b/.test(line));
// Flags come before the first pipe; redirections such as 2>&1 are not flags.
const tokens = (goTests[0] ?? '').split('|')[0].split(/\s+/).filter((token) => token && !/^\d?>/.test(token));

test('the go job splits the db package from every other package across matrix shards', () => {
  assert.ok(
    go.some((line) => /^\s+shard:\s*\[db,\s*rest\]\s*$/.test(line)),
    'expected `shard: [db, rest]` in the go job matrix',
  );
  assert.ok(
    go.some((line) => line.trim() === 'SHARD: ${{ matrix.shard }}'),
    'the test step must read the shard from the matrix',
  );
  assert.ok(commands.includes('db) packages=./db ;;'), 'the db shard must test ./db');
  assert.ok(
    commands.includes(`rest) packages=$(go list ./... | grep -v '/packages/ingestion/db$') ;;`),
    'the rest shard must test every package except db',
  );
  // Without this, a renamed or missing shard would silently skip the db package.
  assert.ok(
    commands.some((line) => line.startsWith('*)') && line.endsWith('exit 1 ;;')),
    'an unknown shard must fail the step',
  );
  // tee exits 0, so a build failure or timeout panic only fails the step through pipefail.
  assert.ok(commands.includes('set -o pipefail'), 'the test step must set -o pipefail');
  assert.equal(goTests.length, 1, `expected one go test command, found ${JSON.stringify(goTests)}`);
  assert.ok(tokens.includes('$packages'), `expected $packages in: ${goTests[0]}`);
});

test('go test runs one package at a time', () => {
  assert.deepEqual(flagValues(tokens, 'p'), ['1'], `expected exactly one -p 1 in: ${goTests[0]}`);
});

test('the per-package go test timeout is positive and shorter than the job timeout', () => {
  const job = go.map((line) => line.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/)).find(Boolean);
  assert.ok(job, 'the go job has no timeout-minutes');
  const timeouts = flagValues(tokens, 'timeout');
  assert.equal(timeouts.length, 1, `expected exactly one -timeout in: ${goTests[0]}`);
  const minutes = timeouts[0]?.match(/^(\d+)m$/);
  assert.ok(minutes, `expected -timeout <N>m, got ${timeouts[0]}`);
  assert.ok(
    Number(minutes[1]) > 0 && Number(minutes[1]) < Number(job[1]),
    `go test -timeout ${minutes[1]}m must be positive and shorter than timeout-minutes ${job[1]}`,
  );
});
