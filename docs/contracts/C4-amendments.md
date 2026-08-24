---
description: How session replay chunks connect browser errors to scrubbed playback.
---
# Session replay data flow

The browser SDK records a session as a stream of bounded chunks. An error points into that stream with a session ID and the error time instead of uploading a second recording just for the error.

Each regular chunk contains ordered replay events and enough initial state to play on its own. The SDK also flushes its current buffer after an error is accepted, which makes the activity around that error available without waiting for the next routine flush.

Ingestion stores chunk metadata in Postgres and chunk bodies in the configured replay object store. A server-side scrub processes each object before any reader can fetch it. The dashboard, API, session analyzer, and investigation path all use the authenticated, project-scoped, scrubbed read path.

An error pointer can exist while its replay chunks are still uploading or scrubbing. Readers treat that period as processing rather than as missing evidence.

Older SDKs may use the legacy replay upload and project-scoped retrieval routes. Current SDKs use session chunks, and new integrations should use that path.
