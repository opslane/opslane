---
"@opslane/sdk": major
---

The Vite plugin now reads its upload destination out of the source-map key
itself. `OPSLANE_SOURCEMAP_KEY` must be an endpoint-bearing key
(`opslane_sk_<key id>_<secret>_<payload>`) minted by an Opslane server at or
above this release; a key minted before the format change is refused with
`OPSLANE_VITE_KEY_INVALID (legacy_format)` and nothing is uploaded. The
`OPSLANE_ENDPOINT` variable is removed: a stale value is reported via
`OPSLANE_VITE_ENDPOINT_REMOVED` and never obeyed. Re-mint your key with
`mint-key -scope sourcemaps` and delete the endpoint variable from CI.
