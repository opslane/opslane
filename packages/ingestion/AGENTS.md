# Ingestion guidance

The ingestion service is the Go API and owns grouping, persistence, migrations, and S3-compatible storage.

## Boundaries

- Keep HTTP handlers in `handler/` and database operations in `db/`.
- Scope every database helper to the required project or organization, and enforce that scope in its query.
- Treat `001_baseline.sql` as the consolidated baseline. Add schema changes as append-only migrations starting at `002`.
- Make migrations safe to reapply with guarded operations such as `IF NOT EXISTS`.

## Verification

- Run `go build ./...` and `go test -p 1 -timeout 30m ./...` from `packages/ingestion`. Test packages share one database and some run sweepers that are not scoped to a project, so packages running in parallel corrupt each other's fixtures. The `db` package alone can exceed Go's default 10-minute timeout on a slower machine.
- For focused database or handler work, run `go test -p 1 -timeout 30m ./db ./handler` while iterating.
- Apply migration SQL to a disposable clean database and a representative existing database, then reapply it to verify idempotency.
- Build the ingestion Compose image after Dockerfile changes.

## Grouping

- `GROUPING_DEBUG_ID_FRAMES` (default `false`, read once at start-up) keys
  JavaScript stack frames on `debug_meta` debug IDs instead of bundle URLs.
  Roll it out to every ingestion task BEFORE flipping it: flag-on and flag-off
  instances key the same event differently. Enabling it re-keys every JS group
  carrying `debug_meta` and each re-keyed group alerts once as new. A bug whose
  events do not all carry matching `debug_meta` will split permanently between
  the two keys. It does not address per-deploy splintering — debug IDs change
  per deploy (see #77) — and it deliberately does not substitute on frames the
  asset-hash rule already collapses (`index-<hash>.js`), because those are
  already deploy-stable and a per-build debug ID would re-splinter them.
  Substitution is confined to the five leading stack lines that reach the hash.
