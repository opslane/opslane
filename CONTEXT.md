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
A logged-in human (dashboard or CLI). The only way to read customer data —
no project key of any scope can read.

**Reserved: `opslane_rk_`**:
A reserved prefix (refused by CLI env writers) with no implementation. Do
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

## Flagged ambiguities

- "The cloud" = the operator-hosted multi-tenant Opslane deployment (live
  today, running AMFJ and others), not a future product. Self-hosted
  instances are the same software operated by the customer.
- "Minting manually" = running `cmd/mint-key` against the database — a
  program, not raw SQL (raw SQL cannot produce the show-once secret).
