---
description: Session replay chunk, pointer, scrub, and retention invariants.
---
# Session replay contract (amended 2026-07-15)

The current SDK records replay data as an always-on stream of bounded session
chunks. Error incidents refer into that stream with a pointer rather than
uploading a second one-shot recording.

1. An incident may include `session_pointer: { session_id, error_at }`, where
   `error_at` is the linked error event's RFC3339 timestamp. Pointer identity is
   valid before chunks finish scrubbing; readers treat that interval as processing.

2. Regular chunk envelopes contain `{ events, meta }`. Events are ascending by
   `timestamp`, and each regular chunk opens with rrweb `Meta` followed by
   `FullSnapshot`, making it independently playable. Chunk reads are project-scoped,
   authenticated, scrubbed-only, decoded JSON:
   `GET /api/v1/projects/{projectID}/sessions/{sessionID}/chunks/{seq}`.

3. The current SDK flushes its in-flight buffer through the session chunk protocol
   when an error is accepted. It does not produce `/api/v1/replays/*` uploads.

4. The project-scoped legacy retrieval endpoint and `/api/v1/replays/*` ingest
   routes remain accepted for older SDKs and incidents:
   `GET /api/v1/projects/{projectID}/replays/{replayID}` (session/JWT auth).

5. rrweb remains pinned to `rrweb@2.0.0-alpha.18` and
   `@rrweb/types@2.0.0-alpha.18`.
