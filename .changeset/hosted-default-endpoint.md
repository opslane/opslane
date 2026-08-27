---
"@opslane/sdk": patch
---

The default `endpoint` now points at `https://app.opslane.com`, the host that
actually serves the hosted Opslane API. The previous default,
`https://api.opslane.com`, was never wired to an origin and answered every
request with a Cloudflare 403 block page, so any `init()` that omitted
`endpoint` on hosted Opslane failed CORS preflight and sent nothing.
Integrations that pass `endpoint` explicitly are unaffected.
