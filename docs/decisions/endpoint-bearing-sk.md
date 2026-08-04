# The source-map key carries its own endpoint

Date: 2026-08-04
Status: accepted and implemented; production cutover pending (plan:
`docs/plans/2026-08-04-sourcemap-token.md`)

## Context

Uploading source maps required two env vars that had to agree —
`OPSLANE_SOURCEMAP_KEY` and `OPSLANE_ENDPOINT`. Forgetting the endpoint
silently skipped uploads; this happened in the first production cutover.
Research across six competitors
(`docs/research/2026-08-04-sourcemap-upload-endpoint-defaults.md`) showed
the industry defaults the endpoint to the vendor cloud, except that Sentry's
newest build-time credential (RFC 0091 org tokens) embeds the URL in the
token and forbids client-side fallbacks — their conclusion after operating
both models. Opslane is cloud-first (the operator-hosted deployment already
serves multiple tenants) but the software is also self-hosted, and the
upload payload is customer source code: HTTP transmits the body before a
401 arrives, so a wrong default URL sends source off-infrastructure.

## Options considered

1. **Default the endpoint to the Opslane cloud URL** (the majority industry
   pattern). Rejected: a self-hoster who sets only the key would transmit
   source maps to the vendor on a misconfiguration; and forgetting the
   override reproduces exactly the silent-failure class we were fixing.
2. **A wrapper value (`opslane_smt_`)** containing `{url, sk}` — zero server
   changes. Rejected after two review rounds: a third artifact with its own
   prefix, env var, redaction trail, and deprecation matrix, purely to avoid
   touching a parser; and the server would not understand the value it was
   effectively issuing.
3. **Change the sk format itself to carry the URL** (chosen). Viable only
   because approximately zero sks were deployed at decision time — the
   grammar change cost two re-mints instead of a migration program.

## Decision

`opslane_sk_<keyid:26>_<secret:43>_<base64url payload>` where the payload is
strict JSON `{v:1, iat, url}`. One env var configures CI; the plugin reads
the destination from inside the key; the server authenticates keyid+secret
exactly as before and enforces the payload schema without using its content
for authorization. Hard cutover: no legacy pair, no transition release.

**Why the payload is last, parsed by fixed offsets:** base64url contains
underscores, so separator-splitting is ambiguous; keyid and secret have
fixed widths, so `[11:37)` / `[38:81)` / `[82:]` is not. Length caps are
enforced before any decoding.

## Accepted limits

- **No integrity binding.** The payload is routing convenience, not
  cryptographic sealing — a holder of the key can rewrite the URL. The key
  is a bearer secret either way; the design defends against accidental
  misrouting, not a malicious key-holder.
- **https-only URLs** (loopback excepted). Plain-HTTP internal hostnames
  are unsupported for uploads; such deployments front ingestion with TLS.
- The server does not check that the embedded URL names itself; a key
  replayed against another Opslane instance still authenticates by secret.

## Consequences

- The frozen S0 §3 sk grammar is amended (explicitly, per repo guardrail).
- `NewProjectKey`/`CreateProjectKey*` require an endpoint for sourcemaps
  scope, making bare-sk minting impossible at the API level.
- Existing bare sks remain server-valid but nothing mints them and the
  plugin refuses them. The two deployed ones must still be re-minted and
  their old key IDs explicitly revoked — that is the production cutover
  runbook (impl plan Task 6), which requires prod access and runs after
  merge and deploy. Until it runs, both old sks are live bearer secrets.
- `OPSLANE_ENDPOINT` is removed. A future cloud console inherits one-value
  key issuance with the cloud URL embedded, with no further design work.
