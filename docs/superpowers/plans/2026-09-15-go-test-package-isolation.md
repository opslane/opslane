# Go Test Package Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Go integration tests in one package from corrupting another package's fixtures, by running test packages one at a time against the shared CI Postgres. Pin that rule with a policy test.

**Architecture:** CI runs `go test ./... -v -timeout 30m` against one database. Go runs up to 4 test packages at once, and several packages call sweepers that are not scoped to a project and read and write every tenant's rows. Inside a package, test cases run one after another: there are no `t.Parallel()` calls or `TestMain` functions, and the only explicit goroutines (`digest/validate_test.go:94-102`) are joined before the test returns. So `-p 1` removes every cross-package path found below with a one-line change. The worker already made the same call: `packages/worker/vitest.config.ts` serializes test files whenever a real database is attached. A Node policy test in `scripts/__tests__/` fails if `-p 1` is removed, or if the per-package `-timeout` stops being positive and shorter than the job's `timeout-minutes`.

**Tech Stack:** GitHub Actions YAML, Go 1.25 (`packages/ingestion/go.mod`) `go test`, Node 22 `node:test`.

**Spec:** This plan has no separate spec. The Problem section below is the specification. Investigation evidence from 2026-09-15: CI failures from Sep 1 to 15, a scratch reproduction against a freshly migrated database, and CI Postgres server logs. The plan was revised after a Codex review.

## Revision after pre-landing review (2026-09-15)

The implemented CI change differs from Task 1 Step 3, which ran a single `go test ./... -p 1`.

**Why it changed.** The performance review found that the Go job is already the slowest CI job:
- On two Blacksmith main runs, the Go job took 294s and 464s, against 223s for JS and 282s for Keyless E2E.
- Running every package serially would have added about 2 minutes to every PR that touches Go.
- `db` is the only slow package. On `ubuntu-latest` it once took 736s, which is more than a 12-minute per-package timeout.

**What was built.**
- **Two matrix shards.** The `go` job runs as `shard: [db, rest]`, and each shard gets its own Postgres service container. The `db` shard runs `go test ./db`. The `rest` shard runs every other package, from `go list ./...` minus `db`, with `-p 1`.
- **Isolation.** No two packages ever share a database at the same time.
- **Wall time.** It stays about the `db` package's time plus setup. The cost is one extra runner's setup, about 40–70s.
- **Timeouts.** `-timeout 15m` per package and `timeout-minutes: 20` per shard. The `db` shard runs one package, so its 15 minutes starts after a setup of about 1–2 minutes, which leaves room for a goroutine dump before the job is killed.

**Corrected measurements.**
- Packages other than `db` took 95–133s, not about 150s.
- At `-p 4`, the whole test step took only 5–6s longer than `db` alone. That gap is all the build, link, vet and small-package time, so serial compilation in the `rest` shard costs well under 30s.

**Policy test.** It now checks the matrix and the shard commands, not a single `go test ./...`. It also pins three things that keep the `db` package from dropping silently out of CI:
- the `SHARD` env mapping;
- a `case` that exits 1 on an unknown shard;
- `set -o pipefail`, because `tee` exits 0.

**Job names.** The jobs are now named `Go build and test (db)` and `Go build and test (rest)`. The commands in Task 1 Step 8 must select those names, not `Go build and test`.

**Local timeout.** The local commands in AGENTS.md add `-timeout 30m`, because the `db` package can take longer than Go's default 10-minute per-package timeout on slower machines.

## Problem

**Digest flake:** `packages/ingestion/digest` tests failed 6 times in 5 CI runs, and every one passed when the same commit was rerun. A single `priority` test failed once. The verified interference paths:

1. **Priority sweeper queues jobs for every project.** `priority/sweeper.go:293` (`enqueueRouteMapJobsSQL`) runs `INSERT INTO error_group_jobs (project_id, job_type) SELECT p.id, 'route_map' FROM projects p WHERE p.github_repo IS NOT NULL ...` with no project filter. A digest fixture then fails cleanup with `error_group_jobs_project_id_fkey`, as `TestValidateOnPRCardRepeatsFromCache` did. A scratch program seeded a digest-style tenant and ran `priority.Sweeper.RunOnce`, which inserted 1 `route_map` job for that tenant, and cleanup failed with the same FK error.
2. **Priority sweeper overwrites impact on every open group.** `priority/sweeper.go:260` (`stampImpactSQL`) and `:274` (`clearStaleImpactSQL`) touch all open groups. The digest freeze reads `g.impact_class, g.impact_visits` (`digest/actionable.go:170`), which produces `actionable receipt omitted impact or replay`.
3. **Retention marks every project's oldest sessions for deletion.** `db/sessions.go:426-438` (`SessionsToDelete`) has no project filter and orders by `started_at ASC`, so 1970-dated fixture sessions go first. `retention/retention.go:95-104` marks them `deleting`, and replay lookup then drops them (`db/sessions_read.go:393`), which produces `replay URL = ""`.
4. **Deadlocks recorded in CI Postgres logs:**
   - `scoreErrorGroupsSQL` (`priority/sweeper.go:76`) against the digest cleanup `DELETE FROM error_groups WHERE project_id IN (...)`.
   - The same scoring query against `digest/sla_test.go:15` `UPDATE error_groups SET status='resolved'`, which is the `priority/sweeper_test.go:288` deadlock.

**15-minute timeouts:** the three Go job timeouts were slow `ubuntu-latest` runners, not a hang.
- With `-p` above 1, `go test` buffers each package's output and prints packages in order, so the log stopped at the package before `db` while `db` was still running.
- `-timeout 30m` is longer than the 15-minute job timeout, so the job was killed before Go could print goroutine stacks.

**Measured package times on Blacksmith** (four passing runs, packages 4 at a time): `db` 235–385s, `digest` 49–78s, `handler` 39–45s, and every other package under 10s.
- **Test execution** run serially should add about 1.5–2.5 minutes to the Go job.
- **Compiling and linking** test binaries is also serialized by `-p 1`. The earlier parallel `go build` and `go vet` steps warm part of that work, but the remaining cost is unmeasured and could be tens of seconds or minutes. It will be measured on the PR.
- **Cached results:** recent Go job logs show no `(cached)` test results, so CI runs tests fresh and `-count=1` is not needed.

**Deliberately out of scope:**
- **A separate database per package.** It keeps parallelism, and `digest/known_problems_integration_test.go:21-50` already shows a disposable-database helper. It is the follow-up if the Go job becomes the slowest CI job.
- **Project-scoping the sweepers for tests.** No production SQL changes.
- **Rewriting `go test ./...` examples in historical plans and design docs.**

## Global Constraints

- Every third-party action stays pinned to a full commit SHA (`scripts/check-action-pins.mjs`). This plan adds no actions.
- `pnpm test:repo` must pass. Its `docs:map:test` step runs `node --test scripts/__tests__/*.test.mjs`, so a new test file there joins the repo gate automatically.
- The Go job must keep failing on unexpected skips (`../../scripts/check-go-skips.mjs /tmp/go-test.log`). Keep the `tee /tmp/go-test.log` pipeline and `set -o pipefail`. `check-go-skips.mjs` parses completed result lines, so streamed output stays compatible.
- No YAML parser dependency. Existing workflow tests read files with `node:fs` and plain string matching.
- Keep the change inside this issue. Do not change Go test helpers, sweepers or production SQL.

## File Structure

- Create `scripts/__tests__/ci-go-test-isolation.test.mjs`: a policy test that reads `.github/workflows/ci.yml`. It checks that the `go` job's `Test (fails on unexpected skips)` step runs exactly one `go test ./...` with exactly one `-p 1` and exactly one positive per-package `-timeout` shorter than the job's `timeout-minutes`.
- Modify `.github/workflows/ci.yml:99` (`timeout-minutes`) and `:170-174` (the Go test step, plus a comment).
- Modify `AGENTS.md:29` and `:60`, and `packages/ingestion/AGENTS.md:14-15`, so every active local instruction runs packages serially.

---

### Task 1: Run Go test packages serially in CI and pin it with a policy test

**Files:**
- Create: `scripts/__tests__/ci-go-test-isolation.test.mjs`
- Modify: `.github/workflows/ci.yml:99`, `.github/workflows/ci.yml:170-174`
- Modify: `AGENTS.md:29`, `AGENTS.md:60`, `packages/ingestion/AGENTS.md:14-15`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the policy test file, which `pnpm docs:map:test` (part of `pnpm test:repo`) picks up through its `scripts/__tests__/*.test.mjs` glob.

- [ ] **Step 1: Write the failing policy test**

Create `scripts/__tests__/ci-go-test-isolation.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Go integration test packages share one Postgres in CI, and several call
// sweepers that are not scoped to a project (priority, retention) and rewrite
// other packages' fixtures. Test cases inside a package run sequentially, so
// `-p 1` is what keeps packages from interfering. The per-package -timeout must
// stay positive and shorter than the job timeout, so a slow package can print
// goroutine stacks instead of being killed silently.
const lines = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').split('\n');

/** Lines of one top-level job, from `  <id>:` up to the next job. */
function jobLines(id) {
  const start = lines.indexOf(`  ${id}:`);
  assert.notEqual(start, -1, `job \`${id}\` not found in ci.yml`);
  const end = lines.findIndex((line, i) => i > start && /^ {2}[A-Za-z][\w-]*:\s*$/.test(line));
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
const goTests = runCommands(go, 'Test (fails on unexpected skips)').filter((line) => /^go test\b/.test(line));
// Flags come before the first pipe; redirections such as 2>&1 are not flags.
const tokens = (goTests[0] ?? '').split('|')[0].split(/\s+/).filter((token) => token && !/^\d?>/.test(token));

test('the Go test step runs a single go test over every package', () => {
  assert.equal(goTests.length, 1, `expected one go test command, found ${JSON.stringify(goTests)}`);
  assert.ok(tokens.includes('./...'), `expected ./... in: ${goTests[0]}`);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the repository root: `node --test scripts/__tests__/ci-go-test-isolation.test.mjs`

Expected: `ℹ pass 1` and `ℹ fail 2`. `go test runs one package at a time` fails with `expected exactly one -p 1`, and the timeout test fails with `go test -timeout 30m must be positive and shorter than timeout-minutes 15`.

- [ ] **Step 3: Change the Go job**

In `.github/workflows/ci.yml`, change line 99 inside the `go:` job from:

```yaml
    timeout-minutes: 15
```

to:

```yaml
    timeout-minutes: 20
```

Replace the test step at lines 170-174:

```yaml
      - name: Test (fails on unexpected skips)
        run: |
          set -o pipefail
          go test ./... -v -timeout 30m 2>&1 | tee /tmp/go-test.log
          ../../scripts/check-go-skips.mjs /tmp/go-test.log
```

with:

```yaml
      # Packages share this Postgres, and some run sweepers that are not scoped to a
      # project (priority, retention) and rewrite other packages' fixtures, so run one
      # package at a time. -timeout is per package: 12m is about twice the slowest db
      # package seen on Blacksmith and sits under the 20m job timeout, so a stuck
      # package usually prints goroutine stacks before the job is killed.
      - name: Test (fails on unexpected skips)
        run: |
          set -o pipefail
          go test ./... -p 1 -v -timeout 12m 2>&1 | tee /tmp/go-test.log
          ../../scripts/check-go-skips.mjs /tmp/go-test.log
```

A successful serial run on Blacksmith needs about 9 minutes of tests (385s for `db` plus about 150s for the rest), plus setup, migrations, the reapply check, build, vet and serialized test compilation. 20 minutes covers that with margin. A goroutine dump is likely but not guaranteed: a package that starts late can still reach the job deadline before its own 12 minutes expire.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/__tests__/ci-go-test-isolation.test.mjs`

Expected: `ℹ pass 3`, `ℹ fail 0`.

- [ ] **Step 5: Make the local instructions match CI**

In `AGENTS.md`, change line 29 from:

```bash
(cd packages/ingestion && go build ./... && go test ./...)
```

to:

```bash
(cd packages/ingestion && go build ./... && go test -p 1 ./...)
```

In `AGENTS.md` line 60, change ``confirm `go test ./...` reported **zero** skips`` to ``confirm `go test -p 1 ./...` reported **zero** skips``. Leave the rest of that line as it is.

In `packages/ingestion/AGENTS.md`, replace lines 14-15:

```markdown
- Run `go build ./...` and `go test ./...` from `packages/ingestion`.
- For focused database or handler work, run `go test ./db ./handler` while iterating.
```

with:

```markdown
- Run `go build ./...` and `go test -p 1 ./...` from `packages/ingestion`. Test packages share one database and some run sweepers that are not scoped to a project, so packages running in parallel corrupt each other's fixtures.
- For focused database or handler work, run `go test -p 1 ./db ./handler` while iterating.
```

- [ ] **Step 6: Run the repository gate for workflow and docs changes**

```bash
env -u OPSLANE_MINIO_HOST_PORT -u OPSLANE_POSTGRES_HOST_PORT -u INGESTION_PORT -u INGESTION_URL \
  -u DATABASE_URL -u MINIO_ENDPOINT -u REPLAY_STORE_ENDPOINT -u REPLAY_STORE_PUBLIC_ENDPOINT pnpm test:repo
```

Expected: exit 0, and every node test summary reports `fail 0`. The port variables are unset because values leaked from other local stacks break `check-compose-ports`.

If `actionlint` is available (for example a release binary downloaded to a scratch directory), also run:

```bash
actionlint -shellcheck= -ignore 'label "blacksmith-4vcpu-ubuntu-2404" is unknown' .github/workflows/ci.yml
```

Expected: exit 0. The Blacksmith runner label is unknown to actionlint on main too.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml scripts/__tests__/ci-go-test-isolation.test.mjs AGENTS.md packages/ingestion/AGENTS.md
git commit
```

Use a commit message in the repository's style. Subject: `ci: run Go test packages serially against the shared Postgres`. Body: the problem (cross-package interference and silent timeout kills), then the change.

- [ ] **Step 8: Verify on CI after the PR is opened**

These results must come from the PR's CI run, because CI is the only environment that runs the whole Go suite against its Postgres service.

```bash
run=$(gh run list --branch <branch> --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
job=$(gh run view "$run" --json jobs --jq '.jobs[] | select(.name=="Go build and test") | .databaseId')
gh run view "$run" --json jobs --jq '.jobs[] | select(.name=="Go build and test") | "\(.conclusion) \(.startedAt) \(.completedAt)"'
gh run view "$run" --log --job "$job" > /tmp/go-job.log
grep -c 'go test ./... -p 1 -v -timeout 12m' /tmp/go-job.log
grep -cE '^\S+\s+\S+\s+\S+\s+ok\s+\S+\s+\(cached\)' /tmp/go-job.log
grep -E 'ok\s+github.com/opslane/opslane/packages/ingestion/(db|digest|handler)\s' /tmp/go-job.log
```

Expected:
- `Go build and test` concludes `success`.
- The `-p 1` command appears at least once.
- There are 0 `(cached)` results, so the tests ran fresh.
- `db`, `digest` and `handler` report real durations.
- Record the Go job's total duration in the PR description, next to the 238–464s measured on recent Blacksmith runs.
