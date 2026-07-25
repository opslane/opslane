---
'@opslane/sdk': major
---

Replay chunks now upload in a single authenticated request to ingestion instead of a presigned-URL handshake with object storage.

**Breaking:** the SDK no longer calls `POST /api/v1/sessions/{id}/chunks/upload-url` or `POST /api/v1/sessions/{id}/chunks/{seq}/commit`. It posts the gzipped chunk directly to `POST /api/v1/sessions/{id}/chunks/{seq}`. Upgrade ingestion before, or at the same time as, the SDK.

This fixes replay recording on Cloudflare R2, which does not implement the S3 POST Object API and rejected every chunk upload with `501 NotImplemented` (#194). It also cuts chunk uploads from three network round trips to one.
