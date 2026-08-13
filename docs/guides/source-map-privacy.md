---
covers:
  - cli/src/codemods/vite-messages.ts
  - packages/sdk/vite-plugin/**
  - packages/ingestion/handler/sourcemap.go
  - packages/worker/src/source-map.tsdescription: Where uploaded source maps are stored and who can read them.
---

# Source-map privacy

A source map is not harmless build metadata. When it includes `sourcesContent`,
it is a readable copy of the source used to produce a browser bundle. Enabling
source maps means giving Opslane private source so it can turn minified stack
frames back into original files, lines, functions, and short source snippets.

## Where source goes

The Vite plugin generates hidden maps, uploads them from the build, and removes
them from the deploy output. They are not referenced by browser bundles and
must not be published to your CDN.

Opslane stores maps under a project-specific prefix. Database identities also
include the project, so identical third-party bundles are not deduplicated
across customers. Storage is private, encrypted at rest, and reached over TLS.
There is no public or presigned download URL.

The source-map secret key is write-only: it can create an upload batch and send
files, but it cannot read maps or other project data. Dashboard and session
credentials do not expose a map-download endpoint either. The worker is the map
reader inside the service network.

## AI-assisted investigations

Resolved source paths and snippets are used during investigations. The snippets
sent to the fix agent therefore reach the configured AI model provider. This is
the product working as intended, but it is a separate data flow from storing the
map and should be included in your own security and privacy review.

Map content and resolved source must not enter logs, error responses, or
metrics. The dashboard renders resolved source as untrusted text; it never
renders or downloads the map file itself.

## Retention

Source maps do not expire automatically yet. Project deletion removes the
project's map objects and cached resolved event snippets, subject to the
deployment's backup-retention policy. If that retention is unsuitable, do not
enable source-map upload until an appropriate policy is available.

