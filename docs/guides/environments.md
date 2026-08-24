---
covers:
  - packages/ingestion/db/environments.go
  - packages/ingestion/db/migrations/032_project_default_environment.sql
  - packages/sdk/src/config.ts
description: Label telemetry by environment and limit automatic error investigation to chosen ones.
---

# Environments

An environment splits a project's issues and sessions by where they came from: `production`, `staging`, a preview deployment. The first event or session recording that carries a new valid label creates the environment; nothing is configured in advance.

## Set it in the SDK

```ts
import { init } from '@opslane/sdk';

init({
  apiKey: import.meta.env.VITE_OPSLANE_API_KEY,
  environment: import.meta.env.VITE_OPSLANE_ENVIRONMENT ?? 'development',
});
```

Set `VITE_OPSLANE_ENVIRONMENT` per deployment at build time. The `?? 'development'` fallback keeps local work out of your production numbers.

## How labels resolve

Three rules cover everything:

1. **A valid label is used exactly as sent.** If it names an environment that doesn't exist yet, the environment is created on the spot. There is no allowlist to maintain.
2. **A missing or invalid label falls back to the project's default environment.** The event is still accepted; the invalid value is not stored.
3. **A session keeps its first environment for its whole life.** Changing the label mid-session does not move the session.

A valid label is 1 to 64 characters of letters, numbers, `.`, `_`, or `-`. Matching is case-sensitive: `Staging` and `staging` are two different environments.

## The default environment

Every project starts with `production` as its default. The default is where events land when no usable label arrives. You can change it in the dashboard under **Settings → Environments**; the change applies to future events only, and existing sessions keep the environment they started with.

## Where environments show up

The issue list filters by environment, and each issue carries per-environment counts, so a staging-only bug shows up as staging-only. A fresh browser session opens the issue list filtered to the project's default environment; choosing "all environments" sticks across reloads.

## Limit automatic error investigation by environment

By default, an error in any environment can trigger an investigation, and investigations cost real money and can open pull requests. If you don't want staging errors doing that, enable the scope under **Settings → Environments** and pick the environments allowed to trigger error investigation.

- Events outside the scope still ingest, resolve, settle into issues, and show up in the per-environment counts. The scope controls whether their observations can admit an error issue to repository inquiry, not whether Opslane stores them.
- The scope fails closed: enabled with an empty list means no environment triggers an error investigation.
- Manually triggered fixes bypass the scope.
- Projects that never enable the scope behave exactly as before.

The scope covers error investigation only. Session recording, session analysis, friction issues, and the fix pull requests the friction pipeline opens under your autonomy setting run in every environment regardless of the scope.

## If staging traffic shows up as production

An SDK with no `environment` option sends everything to the project default, which starts as `production`. Two things to check:

- Every non-production build sets the `environment` option.
- The label passes the format rules above. A value like `staging!` is invalid and falls back silently; the event still arrives, just in the wrong place.
