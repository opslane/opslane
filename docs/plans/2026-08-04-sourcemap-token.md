# Endpoint-bearing sk: the source-map key carries its own URL

Status: revision 5 — Codex round 3 applied to the pivoted design:
NO third prefix; the sk format itself carries the endpoint. Hard cutover.
Supersedes revisions 1-3's `opslane_smt_` wrapper.
Model: Sentry RFC 0091 — endpoint inside the build-time credential, no
client-side URL fallback. Research:
`docs/research/2026-08-04-sourcemap-upload-endpoint-defaults.md`.
Codex rounds 1-2 hardened the wrapper design; every finding that survives
the pivot is carried below.

## Decisions (grilled and locked)

1. **The sk itself carries the URL** — no `opslane_smt_`, no second
   artifact. Rationale: ~zero sks deployed today, so a grammar change costs
   two re-mints now versus a migration program later; one credential type
   keeps the model simple; and the server understanding the full credential
   recovers the RFC 0091 property the wrapper gave up.
2. **Hard cutover.** The new plugin release accepts ONLY the new format;
   the `OPSLANE_ENDPOINT` variable and the bare-sk path are removed
   outright. The two existing sks (AMFJ 2, smoke) are re-minted.
3. Cloud-first ergonomics: keys minted by the cloud embed the cloud URL —
   tenants paste one value and never see an endpoint setting. Self-hosted
   mints embed their own URL, which removes the accidental-misrouting class
   of failure. This is endpoint-carrying convenience, not cryptographic
   sealing: the payload has no integrity binding, so a holder of the key can
   rewrite the URL — consistent with it being a bearer secret.

## Format

```
opslane_sk_<keyid:26 base32>_<secret:43 base64url>_<payload base64url>
payload = {"v":1,"iat":"2026-08-04T12:00:00Z","url":"https://ingest.opslane.com"}
```

- **Payload is LAST, parsed by position and fixed widths** — base64url
  contains underscores, so naive `_`-splitting is ambiguous; fixed offsets
  are not. Byte layout: `opslane_sk_` = [0:11), keyid = [11:37), separator
  at 37, secret = [38:81), separator at 81, payload = [82:]. Validation
  ORDER: total-length cap first (reject > 4096 bytes before any base64 or
  JSON work), then offsets/widths, then payload decode. An empty trailing
  payload (`..._`) is rejected. Any trailing payload on a pk is rejected —
  the pk grammar is unchanged.
- Strict v1 payload: exactly `v` (integer 1), `iat` (RFC 3339 UTC,
  informational only — never an expiry), `url`. Raw unpadded base64url,
  UTF-8 JSON. **One validation contract, two implementations:** the Go
  parser (server) and the TS decoder (plugin) enforce the identical strict
  schema — unknown/duplicate/missing fields, wrong version, and every URL
  violation are rejected by BOTH, against the same golden vectors. "Shape
  validation" means this full contract; authentication still uses only
  keyid+secret.
- `url` policy: absolute origin only — https required; http permitted only
  for loopback (`localhost`, `127.0.0.1`, `[::1]`); no userinfo, path,
  query, fragment; canonicalized (no trailing slash, default ports
  stripped). Caps: url ≤ 2048 bytes, full key ≤ 4096 bytes.
- **Accepted trade-off:** https-only (with loopback exception) excludes
  plain-HTTP internal hostnames (`http://ingestion:8080`). With the legacy
  pair removed there is no escape hatch; such deployments must front
  ingestion with TLS. Documented, not silent.

## Server

- `ParseProjectKey` accepts the trailing payload segment: keyid+secret are
  located by fixed offsets and authenticated exactly as today (same lookup,
  same hash comparison, constant-time compare, exact-key revocation).
  Payload-less keys remain valid credentials at the server (the payload is
  routing, not authority) — but nothing mints them anymore and the plugin
  refuses them.
- The server enforces the full payload contract above (same validator the
  vectors pin), then ignores the CONTENT for authorization. It does not
  verify `url` matches its own address (a key minted for one host and
  replayed against another still authenticates by secret; the URL only
  steers the client).
- **Frozen §3 amendment required**: the sk grammar changes. Explicit
  amendment note in the S0 contract, following existing precedent. The pk
  grammar is untouched.

## Minting

- Endpoint source: configured `OPSLANE_PUBLIC_INGEST_URL` (new env on the
  ingestion deployment; added to the environment reference — deliberately
  not overloading `DASHBOARD_ORIGIN`/`AUTH_CALLBACK_ORIGIN`) is the normal
  source; `-endpoint <url>` is an explicit development alternative. Both
  set and canonicalizing differently → fail. Neither set for
  `-scope sourcemaps` → exit 2 with guidance BEFORE any database insert.
- Validation and canonicalization happen before the insert (a bad endpoint
  discovered after minting would strand an active key whose show-once
  display is spent).
- `-scope ingest` rejects `-endpoint`.
- Output: project identity (existing), then the full endpoint-bearing sk as
  THE value (no bare-sk output — there is only one format now), then key ID
  + unchanged exact-key revocation SQL.

## Plugin

- One env var: `OPSLANE_SOURCEMAP_KEY`, resolved process-env first, then
  Vite file env (`loadEnv`) — process always wins (stale `.env.local` must
  not shadow CI).
- The plugin validates the FULL new grammar (fixed widths + payload) —
  not a prefix check. A key without a payload, or with an invalid payload,
  fails closed with a loud warning naming the defect (never echoing the
  key); there is no fallback of any kind. `OPSLANE_ENDPOINT` is ignored if
  set, with a one-line removal notice.
- Warning states collapse to three: valid key → upload silently; key
  present but invalid/legacy-format → loud warning, skip, build succeeds;
  no key → skip silently.
- Transport: `redirect: 'error'` on the upload fetch — a 307/308 must never
  re-send map bytes or the key to another origin.
- The full key (payload included) goes in `X-API-Key`; the server
  authenticates it natively. No unwrapping.

## Secret hygiene

The `opslane_sk_` prefix already covers the new format in `masking.go`,
`envfile.ts` refusal, and `.gitleaks.toml` IF their patterns tolerate the
longer tail — each must be audited against the new grammar (any pattern
anchored on `[A-Za-z0-9_-]{43}$` truncates). Additionally (Codex round 1,
unchanged by the pivot):

- `packages/worker/src/harness/redact.ts`: add the `opslane_(?:pk|sk)_`
  credential family.
- `packages/worker/src/repo-clone.ts` child-env denylist: add
  `OPSLANE_SOURCEMAP_KEY` (pre-existing omission; bug fixed in passing).
- `packages/ingestion/handler/admin.go` job-error redaction: add the family.
- `scripts/docs-sync/publish.mjs` secret scanner: add raw-key fingerprints
  for `opslane_pk_`/`opslane_sk_` (today it only catches assignments, not a
  bare key pasted into prose).
- Realistic canary tests on every surface.

## Golden vectors

`test-fixtures/sourcemap-key/` in the debug-id style, split by owner:
(a) cross-language VALID vectors — the Go encoder (mint) produces them
byte-exactly, the TS decoder (plugin) accepts them, the Go parser (server)
authenticates them;
(b) decoder-invalid vectors (TS and Go parser reject): bad base64,
duplicate keys, unknown/missing fields, wrong version, bad widths, every
URL violation, oversize;
(c) encoder-invalid inputs (mint refuses): bad URL, oversize.

## Task breakdown

1. Freeze the format: §3 amendment + golden vectors + URL policy.
2. Go: `ParseProjectKey` payload support; payload construction lives in
   the db layer — `NewProjectKey`/`CreateProjectKey*` take the endpoint for
   `ScopeSourcemaps` (required; refuse bare-sk construction) so NO caller
   or test can mint a payload-less sk by accident; mint-key passes the
   endpoint through (validate-before-insert, `OPSLANE_PUBLIC_INGEST_URL`,
   conflict-fail).
3. Plugin: full-grammar validation, payload routing, three-state warnings,
   `redirect: 'error'`, `OPSLANE_ENDPOINT` removal notice.
4. Secret hygiene: pattern audit for the longer grammar + the three missed
   surfaces + canaries.
5. Cutover, complete inventory:
   - Re-mint AMFJ 2 + smoke sks, update their CI, then EXPLICITLY REVOKE
     the old key IDs (creation never revokes — S0 §3.2; skipping this
     leaves the bare keys holding upload authority indefinitely).
   - Test fixtures mint/carry bare sks and must move to the new format:
     `test-e2e/helpers.ts` runtime mint, the fixed keys in
     `scripts/seed-e2e.sql` (both projects), and
     `test-e2e/build-helpers.ts` must stop setting the dead
     `OPSLANE_ENDPOINT` (it would trigger the removal notice on the
     supposedly silent valid path).
   - Delete legacy docs paths; guide + environment reference updates.

## Out of scope

Runtime DSN for the browser pk (separate decision); key-management UI;
server verification of the payload URL against its own identity.
