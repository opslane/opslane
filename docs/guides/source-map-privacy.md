---
covers:
  - packages/sdk/vite-plugin/**
  - packages/ingestion/handler/sourcemap_upload.go
  - packages/ingestion/minio/client.go
  - packages/worker/src/source-map.ts
description: Where uploaded source maps are stored and who can read them.
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

Opslane stores maps under a project-specific object prefix. Database identities also include the project, so identical third-party bundles are not deduplicated across customers. Opslane exposes no public, presigned, or dashboard download route.

The application does not enforce transport encryption or object-store encryption. Those protections depend on the endpoint and storage policy you configure. Use HTTPS for the object-store endpoint and enable encryption at rest in your S3-compatible service.

The source-map secret key is write-only: it can create an upload batch and send
files, but it cannot read maps or other project data. Dashboard and session
credentials do not expose a map-download endpoint either. The worker is the map
reader inside the service network.

## AI-assisted investigations

Resolved source paths, functions, and positions guide investigation toward the relevant files in the connected repository. Source files that the inquiry, investigator, or fix agent reads can reach the configured model provider. Include that separate data flow in your security and privacy review.

The upload and resolution paths do not return map content in API errors or expose a map download route. The dashboard treats resolved stack text as untrusted content.

## Retention

Source maps do not expire automatically. Deleting a project removes its database rows and writes a tombstone for the project's object prefix, but no automatic sweeper removes those objects yet. An operator must delete the recorded object prefix and then clear its tombstone, as described in [source maps](source-maps.md#map-custody). Include object-store backups and replicas in your own retention policy.
