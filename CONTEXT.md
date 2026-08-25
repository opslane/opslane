# Opslane

AI-powered production error-resolution: browser errors in, investigated
incidents and verified fix PRs out. Single-context repo; credentials and
key-handling language below is the part of the domain most easily confused,
so it is pinned first.

## Language

**Ingest key (pk, `opslane_pk_`)**:
The public, per-project key that ships inside the browser bundle and can only
send data (events, replays, sessions). Public by construction — never treat
its exposure as a leak. Cannot read anything or upload source maps.
_Avoid_: "API key" (ambiguous), "public token"

**Source-map key (sk, `opslane_sk_`)**:
The secret, per-project key whose only ability is uploading source maps at
build time. Lives in CI. Cannot send events or read anything.
_Avoid_: "upload token", "secret key" (unqualified)

**Endpoint-bearing sk** (decided and implemented 2026-08-04; not yet deployed):
The sk format carries its issuing server's URL as a trailing base64url
payload: `opslane_sk_<keyid>_<secret>_<payload>`. One value configures CI
(`OPSLANE_SOURCEMAP_KEY`); the plugin reads the URL from inside; the server
authenticates keyid+secret exactly as before and ignores the payload beyond
shape validation. No separate endpoint variable exists.
_Avoid_: "envelope", "smt", "token" — there is no second artifact; it is the sk

**Scope**:
The stored, server-enforced permission of a project key (`ingest` or
`sourcemaps`). The prefix is a label for humans and scanners; the scope in
the database is the law.

**User session**:
A logged-in human (dashboard). The only way to read customer data —
no project key of any scope can read.

**Reserved: `opslane_rk_`**:
A reserved prefix with no implementation. Do
not mint or repurpose without a design.

**Legacy `def_` keys**:
The pre-S1 per-environment keys, destroyed by migration 029 (v26.8.0).
Historical only.

**Environment label**:
The exact, case-sensitive deployment name supplied by an SDK. A valid label is
1–64 characters using letters, numbers, `.`, `_`, or `-`.
_Avoid_: "environment override" — project keys do not carry an environment

**Environment**:
A durable, project-owned identity materialized from the first telemetry carrying
a valid environment label.
_Avoid_: "approved environment", "environment allowlist"

**Default environment**:
The environment used when telemetry omits a label or supplies an invalid one.
Every project begins with `production` as its default.
_Avoid_: "key environment", "production fallback"

**Action scope** (decided 2026-08-12; `docs/contracts/action-scope.md`):
A per-project limit on which environments may trigger automatic error
investigation. It gates job creation and `issue.created` only — events,
rollups, affected users, and the sample always record. Enabled with an empty
selection it fails closed; guided/human fix jobs bypass it. Environments
themselves are never allowlisted: ingestion and environment creation are
unaffected, which is why "environment allowlist" stays an avoided term for
the Environment concept — the scoped thing is automation, not the environment.
_Avoid_: "approved environment"; "environment allowlist" as a standalone term
(say "action scope")

**Usage ledger** (decided 2026-08-08; ADR-0001):
The insert-only Postgres record of what a job spent: one row per
(job, execution, phase, model) carrying provider-returned token counts and
estimated cost. Written best-effort by the worker at phase completion; never
blocks or fails the job, and can undercount (see ADR-0001). Authoritative
relative to Langfuse traces, which carry the same numbers but are optional.
_Avoid_: "billing table" (nothing is invoiced from it; it is not reconciled
provider spend), "cost column"

**Phase**:
A named stage of a job that spends model tokens (e.g. investigation, fix,
judge, narrative). Enumerated in worker code, stored as plain text — a new
phase must not require a migration.

**Outcome score**:
A measurement pushed onto a job's Langfuse trace: the diagnosis outcome and
confidence at decision time, and the PR outcome (merged/closed) later via
the job queue when the GitHub webhook lands.
_Avoid_: "eval" (scores record what happened; evals judge it)

**Product context**:
A project-owned, evolving account of what its routes and actions do, grounded in
repository code and observed sessions. Every claim carries its evidence and
confidence; missing context means unknown, never unimportant.
_Avoid_: "route weight" (one ranking input), "product truth" (the account is partial)

**Observation**:
One captured error or friction signal. It is evidence that exists before Opslane
has necessarily decided which problem it belongs to.
_Avoid_: "issue" (identity may still be unsettled), "occurrence" (a count of observations)

**Capture bucket**:
A provisional collection of observations that share an immediately available raw
fingerprint. It may appear as processing, but owns no impact or lifecycle decision.
_Avoid_: "issue", "canonical group"

**Canonical issue**:
The durable identity of one customer problem. It owns impact, admission,
investigation, lifecycle, and publication; many observations and fingerprints may
belong to it.
_Avoid_: "capture bucket", "error group" when canonical identity is intended

**Fingerprint alias**:
A versioned association from one exact fingerprint to a canonical issue. Raw,
resolved, and component fingerprints may alias the same issue without being
rewritten.
_Avoid_: "canonical fingerprint" (an issue may have several equally valid aliases)

## Relationships

- A **Project** has any number of active keys per **Scope**; minting never
  revokes, revocation is always exact-key.
- A **Project** begins with a `production` **Default environment**. The first
  telemetry carrying any other valid **Environment label** materializes the
  corresponding **Environment** in the same transaction as that telemetry.
- Missing and invalid **Environment labels** use the **Default environment**.
  Invalid raw values are not stored. Changing the default affects future telemetry
  only; an existing session keeps the environment selected when it started.
- A **Source-map key** carries exactly one issuing URL, sealed in at mint
  time; the URL routes uploads, the keyid+secret authenticate them.
- Reads require a **User session**; writes require a key whose **Scope**
  matches the route.
- An **Observation** belongs to one **Capture bucket** while identity is being
  settled and to one **Canonical issue** after settlement.
- A **Canonical issue** may have many **Fingerprint aliases**; each alias identifies
  at most one canonical issue within a project and identity version.

## Flagged ambiguities

- "The cloud" = the operator-hosted multi-tenant Opslane deployment (live
  today, running AMFJ and others), not a future product. Self-hosted
  instances are the same software operated by the customer.
- "Minting manually" = running `cmd/mint-key` against the database — a
  program, not raw SQL (raw SQL cannot produce the show-once secret).
