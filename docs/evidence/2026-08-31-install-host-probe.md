# JavaScript install-host probe — 2026-08-31

The implementation workspace had no E2B, database, or GitHub App credentials,
so the repository-wide probe could not be rerun here. The earlier spike recorded
in the implementation plan installed 199 packages for one opaque repository
with only `registry.npmjs.org` and `github.com` reachable.

That single result is not treated as complete coverage. The shipped bootstrap
allowlist also includes the GitHub clone/raw/release hosts and `nodejs.org` for
`node-gyp`. `scripts/probe-install-hosts.ts` records future runs by opaque index,
never prints raw install logs, pins both runs to one SHA, and rereads the
installation-token file before each repository.
