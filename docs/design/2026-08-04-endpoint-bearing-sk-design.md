# Design: the source-map key carries its own endpoint

Status: accepted and implemented; production cutover pending
Date: 2026-08-04
Decision record: `docs/decisions/endpoint-bearing-sk.md`
Plan of record: `docs/plans/2026-08-04-sourcemap-token.md` (rev 5)
Research: `docs/research/2026-08-04-sourcemap-upload-endpoint-defaults.md`

## 1. Problem

Uploading source maps takes two environment variables that must agree:
`OPSLANE_SOURCEMAP_KEY`, which holds the sk (Opslane's secret per-project
source-map upload key, `opslane_sk_...`), and `OPSLANE_ENDPOINT`, the URL
to send to. Nothing ties them together. In the first production cutover
(2026-08-04, AMFJ 2), the endpoint variable was missing and the plugin
skipped uploads with one warning in a green build log. Nobody saw it. The
plugin has no default endpoint on purpose: source maps are readable source
code, HTTP transmits the request body before a 401 comes back, so a wrong
default would send a self-hoster's source to a server they never chose.

Survey of six competitors (see research doc): five default the upload
endpoint to their cloud. The exception that matters is Sentry's newest
build-time credential (RFC 0091 org tokens), which embeds the URL in the
token and forbids client-side fallbacks: "a token will always have a site
in it and clients are not supposed to provide an automatic fallback."
That is their position after years of operating both models.

## 2. Goals / non-goals

One pasted value configures source-map uploads, for cloud tenants
and self-hosters alike. Forgetting a second variable stops being possible
because there is no second variable.

Non-goals, each deliberate:

- No cryptographic binding of URL to key. The payload steers the client; it
  is not tamper-proof, and does not need to be (see §8).
- No change to the pk (the public ingest key, `opslane_pk_`, that ships in
  browser bundles) or to any read path.
- No runtime DSN for the browser SDK. Separate decision, later.
- No key-management UI. Minting stays in `cmd/mint-key` and, later, the
  cloud console.
- No transition period. Hard cutover, justified in §5.

## 3. Requirements

| # | Requirement | Verified by |
|---|---|---|
| R1 | One env var (`OPSLANE_SOURCEMAP_KEY`) fully configures upload; `OPSLANE_ENDPOINT` is removed. | Plugin env matrix tests; grep proves the variable is gone from code and docs. |
| R2 | The server authenticates new-format keys with unchanged semantics: same lookup, same hash comparison, exact-key revocation. | `ParseProjectKey` unit tests; existing route-matrix and revocation tests pass unmodified. |
| R3 | Old-format (bare) sks cannot be minted by any code path, and the plugin refuses them loudly. | The key constructor takes a required endpoint parameter for sourcemaps scope and errors without one (enforced at the db API, exercised by every mint test); plugin fixture test for the refusal. |
| R4 | Go parser and TS decoder enforce one identical payload contract. | Shared golden vectors under `test-fixtures/sourcemap-key/`, consumed by both suites. |
| R5 | A malformed or oversized key never costs the server meaningful work and never fails a customer build. | Length cap enforced before any decoding (server test); plugin warn-and-skip test. |
| R6 | Upload bytes can only travel to the URL inside the key. | `redirect: 'error'` test; no other URL source exists in the upload code path. |
| R7 | The longer key survives every secret-hygiene surface. | Canary tests: masking, envfile refusal, gitleaks, worker redaction, worker child-env, admin errors, docs-sync scanner. |
| R8 | The two deployed bare sks are re-minted, their old key IDs revoked, and every test fixture moves to the new format. | Cutover checklist in the plan; revoked-key 401 probe; fixture grep. |

## 4. The format

```
opslane_sk_<keyid>_<secret>_<payload>
           26 chars  43 chars  base64url, strict JSON inside
payload = {"v":1,"iat":"2026-08-04T12:00:00Z","url":"https://ingest.opslane.com"}
```

Byte layout, because parsing position matters: prefix `opslane_sk_` is
bytes [0:11), keyid [11:37), separator at 37, secret [38:81), separator at
81, payload [82:].

**Why the payload is last.** base64url's alphabet includes underscores, the
same character the key uses as a separator. Splitting on `_` becomes
ambiguous the moment a payload exists anywhere but the end. keyid and
secret have fixed widths, so fixed-offset parsing has no ambiguity at all.
The current parser (`db/project_keys.go:124`, `SplitN(raw, "_", 4)`) already
handles a related version of this problem (the secret itself can contain
underscores) by treating the fourth component as "the whole remainder."
The new grammar extends that idea: remainder after byte 81 is payload.

**Payload contract** (frozen with golden vectors): raw unpadded base64url;
UTF-8 JSON; exactly three fields: `v` (integer, exactly 1), `iat`
(RFC 3339 UTC, informational, never an expiry), `url`. Unknown, duplicate,
or missing fields are rejected. `url` must be an absolute https origin
(http allowed only for loopback), no userinfo/path/query/fragment,
canonicalized. Caps: url ≤ 2048 bytes, whole key ≤ 4096 bytes, checked
before any base64 or JSON work.

## 5. Why change the key format at all

Three options were on the table (full comparison in the ADR):

1. **Default the endpoint to our cloud**, the majority pattern (Sentry,
   PostHog, Bugsnag, Datadog, Honeybadger all do it). Rejected because a
   self-hoster who sets only the key would transmit source maps to us on a
   misconfiguration, and a cloud tenant who forgets the override is back to
   silent skipping.
2. **A wrapper value** (`opslane_smt_` containing `{url, sk}`) with zero
   server changes. Designed fully, reviewed twice, then rejected: a third
   artifact with its own prefix, env var, redaction trail, precedence
   rules, and deprecation clock, all to avoid touching one parser. And the
   server would not understand the value we were effectively issuing.
3. **The sk carries the URL**, which won. The deciding fact is timing:
   approximately zero sks exist in production (two, minted last night,
   trivially re-mintable). A credential grammar change costs two re-mints
   today; in six months it would cost a migration program. This window
   closes as adoption grows and will not reopen.

Hard cutover follows from the same fact. A transition release supporting
both formats protects nobody (there is nobody to protect) and keeps the
dual-path code and its warning matrix alive for a full cycle.

## 6. Component design

### Server (`ParseProjectKey`, `db/project_keys.go`)

Accepts the trailing payload. keyid and secret are located by fixed
offsets and authenticated exactly as today: same keyid lookup, same
SHA-256-of-secret comparison in constant time (`LookupProjectKey` hashes
only the extracted 43-char secret, which is what the database stores), same
revocation by key ID. The payload is validated against the full contract
(same rules as the plugin, pinned by shared vectors) and then ignored for
authorization. The server does not check that the embedded URL names
itself; a key replayed against another instance still authenticates by
secret. The pk grammar rejects any trailing payload; it is unchanged.

Bare sks remain *valid credentials* at the server (the payload is routing,
not authority), which makes the deploy order safe: server first, then
plugin, then re-mint. But nothing can mint one anymore: `NewProjectKey` and
both `CreateProjectKey*` helpers require an endpoint for sourcemaps scope,
so the bare form is unconstructable at the API level rather than by
convention.

This changes the frozen S0 §3 sk grammar. The amendment is explicit, in
the contract doc, per the repo guardrail, with the v1 source-map
amendments as precedent.

### Minting (`cmd/mint-key`)

The endpoint comes from configuration, not routine typing: a new
`OPSLANE_PUBLIC_INGEST_URL` on the ingestion deployment is the normal
source; `-endpoint` is a development alternative. Both set and disagreeing
after canonicalization → fail. Neither set → exit 2 with guidance *before*
the database insert: a bad endpoint discovered after minting would strand
an active key whose show-once display is already spent. `-scope ingest`
rejects `-endpoint`. Output: project identity first (existing behavior),
then the full key as the single value, then key ID and revocation SQL.

### Plugin (`vite-plugin`)

One env var, process-env before Vite file env (stale `.env.local` never
shadows CI). Validates the full grammar (widths, payload, URL policy),
not just the prefix. Three states: valid key → upload silently; key present
but invalid or bare → one loud warning naming the defect (never echoing
the key), skip, build succeeds; no key → skip silently.
`OPSLANE_ENDPOINT`, if still set, is ignored with a one-line removal
notice. Transport sets `redirect: 'error'`: a 307/308 must never re-send
map bytes or the key to a different origin. The full key goes in
`X-API-Key`; the server understands it natively, so there is no unwrapping step.

### Secret hygiene

The `opslane_sk_` prefix means most scrubbers keep working, but each
pattern gets audited against the longer tail (anything anchored on
`{43}$` truncates). Three surfaces never knew about Opslane keys at all
and get the credential family added: worker output redaction
(`harness/redact.ts`), the worker child-process env denylist
(`repo-clone.ts`, which, it turns out, never denylisted the *current* sk
variable either; fixed in passing), and admin job-error redaction
(`admin.go`). The docs-sync publisher's secret scanner gains raw-key
fingerprints. Every surface gets a canary test.

## 7. Testing

- **Golden vectors** (`test-fixtures/sourcemap-key/`, debug-id style),
  split by owner: valid vectors that the Go encoder must produce
  byte-exactly and both parsers must accept; decoder-invalid vectors both
  parsers must reject (bad base64, field violations, bad widths, URL
  violations, oversize); encoder-invalid inputs the mint must refuse.
- **Unchanged suites as regression proof**: route matrix, revocation,
  upload-route tests pass without edits, proof the auth path did not move.
- **E2E**: the existing `sourcemap-resolution.test.ts` acceptance suite
  runs against re-minted fixtures; the runtime mint helper and both seeded
  keys move to the new format; the build harness stops setting
  `OPSLANE_ENDPOINT`.
- **Live cutover check**: after re-minting AMFJ 2 and smoke, their old key
  IDs are revoked and a probe with the old key must 401.

## 8. Risks and the honest caveat

The payload is not sealed to the key. Anyone holding the key can
decode the payload, change the URL, and re-encode; the plugin will then
send maps (and the key) to that URL. We accept this flatly: the key is a
bearer secret; a holder can already do anything the key allows, including
uploading from a machine they control. The design defends against the
*accidental* misrouting class (wrong or missing variable), which is the
failure that actually occurred. Signing the payload would defend against a
key-holder, who is not in the threat model.

Other accepted risks:

- **https-only breaks plain-HTTP internal deployments** (e.g.
  `http://ingestion:8080` behind a firewall). With the legacy pair gone
  there is no escape hatch; such setups must put TLS in front of
  ingestion. Chosen over an allow-http flag, which would become the
  permanent default in exactly the environments least equipped to notice.
- **Old bare keys stay server-valid until revoked.** The cutover checklist
  makes revocation explicit; the residual risk is an operator skipping
  that step, bounded by the two keys that exist.
- **A replayed key authenticates against any instance.** True today for
  every bearer key; the URL does not change it. Noted so nobody mistakes
  the payload for an audience claim.

## 9. Review trail

Three Codex review rounds (round 1 hardened the wrapper design; rounds 2-3
confirmed fixes and re-reviewed after the maintainer pivoted to the
sk-format change), plus a maintainer grilling session that produced the
pivot itself, the hard-cutover decision, the ADR, and the repo's first
`CONTEXT.md` glossary. Key review catches now in the design: fixed-offset
parsing with length-cap-before-decode, re-mint-then-revoke (re-minting
alone leaves old keys live), the E2E fixture inventory, and the
one-validation-contract rule.
