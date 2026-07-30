# End-to-end test coverage for project keys: implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the end-to-end suite catch a credential-boundary regression and make the stale-test failures that happened on #243 impossible rather than merely fixable.

**Architecture:** Three independent changes. Turn on type checking for the two test packages that currently have none, then give credentials distinct types so a session token cannot be passed where an ingest key belongs. Add a secret key and a revoked key to the shared fixture, since neither exists anywhere in the suite today. Then add one live test that exercises the boundary against the running container instead of in-process.

**Tech Stack:** TypeScript, Vitest, Playwright, Postgres.

## Why this exists

Two tests failed on #243. Both were stale tests asserting behaviour the product had deliberately changed, and both were invisible until CI ran.

The first passed an ingest key to a helper that takes a session token. That compiled because both are `string`, and because **neither test package is type checked at all**:

```
test-e2e/package.json          "test": "vitest run"          ← no tsc
packages/test-reliability/tsconfig.json:14   "exclude": ["src/system"]
```

The second hardcoded a database default that migration 028 changed.

Separately, five things could regress today with no end-to-end test noticing. Verified by searching the suite:

| Regression | Why nothing catches it |
|---|---|
| `opslane_sk_` accepted on `/events`, replays, sessions, or ping | **No secret-key fixture exists anywhere** in `test-e2e/` or `packages/test-reliability/` |
| `/api/v1/ingest/ping` disappears or accepts the wrong credential | **Never called live.** CLI tests mock it (`cli/src/__tests__/setup.test.ts:179`) while `setup.ts:91` and `doctor.ts:164` depend on it |
| A valid public key regains incident reads | The negative test sends `def_invalid_key_12345` (`test-e2e/error-to-pr.test.ts:99`), an obsolete malformed value. That proves malformed input is rejected, not that a valid public key is refused |
| A revoked key keeps working in the running service | Only covered in-process (`handler/auth_middleware_test.go:89`) |
| A user session is accepted on a telemetry route | No live test sends `Authorization: Bearer` to `/events` |

---

## Task 1: Turn on type checking for the two test packages

Do this first. Task 2's branded types are decoration without it.

**Files:**
- Modify: `test-e2e/package.json`
- Modify: `packages/test-reliability/package.json`
- Create: `packages/test-reliability/tsconfig.typecheck.json`
- Leave alone: `packages/test-reliability/tsconfig.json` (the `build` script needs it as-is)

**Step 1: Confirm neither package type checks today**

```bash
cd test-e2e && cat package.json | grep -A3 '"scripts"'
cat ../packages/test-reliability/tsconfig.json | grep -A2 exclude
```

Expected: `test-e2e` runs only `vitest run`; the reliability package excludes `src/system`.

**Step 2: Do NOT just delete the exclude. Add a second config.**

Deleting `"exclude": ["src/system"]` from `packages/test-reliability/tsconfig.json:14`
produces about **50 errors, all TS6059**, and none of them are type bugs. The cause is
`"rootDir": "src"` on line 8: the system tests import from outside that directory, for
example the worker fixture and the e2e helpers at
`src/system/friction-ladder.system.test.ts:8,13,48,118`.

Removing `rootDir` instead would break the emitting `build: "tsc"` script
(`packages/test-reliability/package.json:8`), because the compiler would infer a much
wider common root and pull worker and e2e source into the build output.

Build and type-check need different configs. Leave `tsconfig.json` alone and add
`packages/test-reliability/tsconfig.typecheck.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".."
  },
  "include": ["src"]
}
```

`rootDir: ".."` widens the root far enough to cover the cross-package imports without
touching what `build` emits. Adjust it if the imports reach wider than the plan assumes;
the goal is a config that type checks `src/system` and emits nothing.

**Step 3: Run the type check and see what it finds**

```bash
cd packages/test-reliability && pnpm exec tsc -p tsconfig.typecheck.json
```

Expected: zero TS6059. Any remaining error is a real type problem; fix it and note it,
because that is the class of bug this task exists to surface.

**Step 4: Add a typecheck script to both packages**

`test-e2e/package.json`:

```json
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "tsc --noEmit && vitest run"
  }
```

`packages/test-reliability/package.json`: add
`"typecheck": "tsc -p tsconfig.typecheck.json"` and prefix both test scripts with it.
Leave `build` pointing at the original `tsconfig.json`.

`test-e2e/tsconfig.json` already exists, so no new file is needed there. Check whether it
also sets `rootDir` before assuming `tsc --noEmit` will work.

**Step 5: Prove it catches the original bug**

Reintroduce the exact mistake that failed CI, confirm it now fails at compile time, then revert:

```bash
cd packages/test-reliability
# temporarily change tenant.sessionToken back to tenant.apiKey in
# src/system/worker-success.system.test.ts:232
pnpm exec tsc --noEmit
```

Expected before Task 2: this still passes, because both fields are `string`. That is the point, and it is what Task 2 fixes. Record that it passed so the contrast is visible.

**Step 6: Commit**

```bash
git add test-e2e/package.json packages/test-reliability/package.json packages/test-reliability/tsconfig.typecheck.json
git commit -m "test: type check the e2e and system test packages"
```

---

## Task 2: Give credentials distinct types

**Files:**
- Modify: `test-e2e/helpers.ts`
- Modify: **16 files, 56 references** for the `apiKey` rename, and **8 files, 41
  references** for `sessionToken`. Confirm the current counts before starting:

```bash
grep -rln "\.apiKey\b" test-e2e packages/test-reliability/src --include="*.ts" | wc -l
grep -rln "sessionToken" test-e2e packages/test-reliability/src --include="*.ts" | wc -l
```

This is the bulk of the task. The rename is mechanical; the brand boundaries below are not.

**Step 1: Add the branded types**

At the top of `test-e2e/helpers.ts`:

```ts
// Credentials are all strings on the wire, which is how an ingest key ended
// up in an Authorization header on #243 without the compiler noticing.
// Branding them costs nothing at runtime and makes that swap a type error.
export type IngestKey = string & { readonly __credential: 'ingest' };
export type SourceMapKey = string & { readonly __credential: 'sourcemap' };
export type UserSession = string & { readonly __credential: 'session' };
```

**Step 2: Rename the tenant field and add the missing credentials**

`TestTenant` at `test-e2e/helpers.ts:54`. Rename `apiKey` to `ingestKey` so the name says which credential it is, and add the two that do not exist anywhere in the suite:

```ts
export interface TestTenant {
  orgId: string;
  projectId: string;
  environmentId: string;
  ingestKey: IngestKey;
  sourceMapKey: SourceMapKey;   // new: nothing in the suite has one
  revokedKey: IngestKey;        // new: revocation is only tested in-process
  userSession: UserSession;
}
```

Mint the two new ones the same way `seedProjectIngestKey` does, with `scope` set to `sourcemaps` for one, and revoke the third immediately after creating it.

**Step 3: Type the helper parameters**

`postEvent` takes `IngestKey`. `getIncident`, `listIncidents`, and `listSessions` take
`UserSession`. Do not widen any of them back to `string`.

`pollUntilTerminal` (`test-e2e/helpers.ts:315`) also needs `UserSession`. It still declares
`string` and hands the value to `getIncident` at `:315` and `:326`, so leaving it alone
puts a hole straight through the middle of the change.

**Step 3b: Handle the four brand boundaries**

A branded type needs one cast where a plain string first becomes a credential. There are
exactly four places, and every one is a deliberate boundary rather than a workaround:

1. **The seeding site.** `seedProjectIngestKey` builds the key from a template literal and
   returns `string`. Cast there, once, with a comment: this is where an unbranded value
   legitimately becomes an `IngestKey`.
2. **Three local wrappers** whose own parameters are still `string` and which forward into
   `postEvent`: `test-e2e/environments.test.ts:47`,
   `test-e2e/dashboard-environment-filter.test.ts:48`,
   `test-e2e/dashboard-projects.test.ts:39`. Change their parameter types rather than
   casting at the call site.
3. **A key that arrives over HTTP.** `test-e2e/dashboard-projects.test.ts:21` types
   `second.api_key.raw_key` as `string` from the provisioning response, then sends it to
   ingestion at `:77`. Cast at the response boundary, where the value is known to be an
   ingest key, not at `:77`.

If you find yourself adding a fifth cast, stop: it means a helper signature is wrong.

**Step 4: Run the type check**

```bash
cd test-e2e && pnpm exec tsc --noEmit
cd ../packages/test-reliability && pnpm exec tsc -p tsconfig.typecheck.json
```

Expected: errors at every call site that passes the wrong credential or the old field name.
Fix each by passing the right one. Do not add casts except at the four boundaries in
Step 3b.

**Step 5: Prove the original bug is now impossible**

Reintroduce it again:

```bash
# change tenant.userSession back to tenant.ingestKey at
# packages/test-reliability/src/system/worker-success.system.test.ts:232
pnpm exec tsc --noEmit
```

Expected: a compile error naming the credential mismatch. Revert.

**Step 6: Split key creation out of environment seeding**

`test-e2e/helpers.ts:697`, `seedEnvironment` creates a project-scoped key and returns it as
though the key belonged to the environment. Keys stopped belonging to environments in
#243, so the fixture is teaching a model that no longer exists.

Five call sites. Three consume the returned key and need a replacement source for it:
`environments.test.ts:82`, `dashboard-environment-filter.test.ts:72`,
`friction-incidents.test.ts:157`. One uses only the environment id and needs nothing:
`sdk-environment-browser.test.ts:33`.

If the split turns out to be larger than the rename, do it as its own commit rather than
folding it in.

**Step 7: Commit**

Stage every file the compiler touched, not just the two paths. A commit that stages only
`helpers.ts` and `packages/test-reliability/src` leaves the 14 changed `test-e2e/*.test.ts`
callers behind and produces a revision that does not compile.

```bash
cd test-e2e && pnpm exec tsc --noEmit          # must be clean FIRST
cd ../packages/test-reliability && pnpm exec tsc -p tsconfig.typecheck.json
cd ../..
git add test-e2e packages/test-reliability/src
git status --short                              # eyeball the list before committing
git commit -m "test: brand credential types so a session cannot pass as a key"
```

---

## Task 3: One live boundary test

The Go route matrix already covers this in-process. This covers the deployed container, which is where a routing or CORS mistake actually shows up.

**Files:**
- Create: `test-e2e/credential-boundary.test.ts`
- Modify: `.github/workflows/ci.yml` required-pattern list

**Step 1: Write the test**

```ts
import { describe, expect, it, beforeAll } from 'vitest';
import { seedTenant, getConfig, type TestTenant } from './helpers.js';

describe('credential boundary', () => {
  let tenant: TestTenant;
  const { ingestionUrl } = getConfig();

  beforeAll(async () => { tenant = await seedTenant(); });

  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    error: { type: 'Error', message: 'boundary probe', stack: 'at x (a.js:1:1)' },
  });

  const post = (path: string, headers: Record<string, string>, body?: string) =>
    fetch(`${ingestionUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });

  it('accepts telemetry from the public key only', async () => {
    expect((await post('/api/v1/events', { 'X-API-Key': tenant.ingestKey }, event)).status).toBe(202);
    expect((await post('/api/v1/events', { 'X-API-Key': tenant.sourceMapKey }, event)).status).toBe(403);
    expect((await post('/api/v1/events', { 'X-API-Key': tenant.revokedKey }, event)).status).toBe(401);
    // A session is for reading. It must not be a way to write telemetry.
    expect((await post('/api/v1/events', { Authorization: `Bearer ${tenant.userSession}` }, event)).status).toBe(401);
  });

  it('refuses incident reads to a VALID public key', async () => {
    // The existing negative test sends a malformed def_ key, which proves
    // nothing about a real key that authenticates fine elsewhere.
    const res = await fetch(
      `${ingestionUrl}/api/v1/projects/${tenant.projectId}/incidents`,
      { headers: { 'X-API-Key': tenant.ingestKey } },
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('invalid_api_key');
  });

  it('answers ping for an ingest key and nothing else', async () => {
    expect((await post('/api/v1/ingest/ping', { 'X-API-Key': tenant.ingestKey })).status).toBe(204);
    expect((await post('/api/v1/ingest/ping', { 'X-API-Key': tenant.sourceMapKey })).status).toBe(403);
    expect((await post('/api/v1/ingest/ping', { 'X-API-Key': tenant.revokedKey })).status).toBe(401);
  });

  it('keeps the source-map upload route deleted', async () => {
    expect((await post('/api/v1/sourcemaps', { 'X-API-Key': tenant.ingestKey })).status).toBe(404);
    expect((await post('/api/v1/sourcemaps', { 'X-API-Key': tenant.sourceMapKey })).status).toBe(404);
  });

  it('refuses a wrong-scope key on replay and session routes', async () => {
    for (const path of ['/api/v1/replays/init', '/api/v1/sessions/init']) {
      const res = await post(path, {
        'X-API-Key': tenant.sourceMapKey,
        Origin: 'https://qa.example.com',
      }, '{}');
      expect(res.status, path).toBe(403);
      expect((await res.json()).code).toBe('insufficient_scope');
    }
  });
});
```

**Step 2: Run it against the live stack**

```bash
pnpm --filter @opslane/test-e2e exec vitest run credential-boundary
```

Every expectation is a real status from the running container. If one differs, check the handler before changing the number.

**Step 3: Add it to the required-test gate**

`.github/workflows/ci.yml`, in `E2E_REQUIRED_PATTERNS`:

```
            ^credential boundary >
```

The gate is what turns a silently skipped test into a failed build. #243 proved it works, by failing when two test names drifted.

**Step 4: Commit**

```bash
git add test-e2e/credential-boundary.test.ts .github/workflows/ci.yml
git commit -m "test: cover the credential boundary against the live service"
```

---

## Not in this plan

- **Rewriting the suite.** Everything here is additive.
- **A full `opslane onboard` tracer.** It needs a pseudo-terminal, scripted approvals, and a fake model server. `runOnboardCore` (`cli/src/onboard/core.ts:57`) injects its effects, so a partial version is possible later, but it is a separate piece of work.
- **Moving the migration default out of the dashboard test.** Worth doing, and smaller than the three above. Its own follow-up.

## Done when

1. `pnpm --filter @opslane/test-e2e typecheck` and the reliability equivalent both pass, and are wired into `test`.
2. Passing `tenant.ingestKey` where a `UserSession` belongs is a compile error. Demonstrate it, then revert.
3. `credential-boundary.test.ts` passes against the live stack and is named in the required-pattern list.
