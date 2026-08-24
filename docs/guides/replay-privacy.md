---
covers:
  - packages/sdk/src/config.ts
  - packages/sdk/src/index.ts
  - packages/sdk/src/replay.ts
  - packages/sdk/src/session.ts
  - packages/sdk/src/chunk-upload.ts
  - packages/sdk/src/scrub.ts
description: What session recordings capture, how masking works, and how long recordings live.
---

# Replay privacy and masking

Session replay shows what a user saw and did around an error. It is the most privacy-sensitive feature in the SDK, and session recording is **on by default**. This guide explains the separate session-reporting and replay controls, when recording actually starts, what leaves the browser, how masking works, and how to turn either one off.

By default, every `init()` attempts to report lightweight session metadata to `/api/v1/sessions/init`, even when replay is disabled or the browser cannot record. That request contains no serialized DOM. A stored recording still requires `CompressionStream`, configured object storage, and server approval for the project. If any of those checks fail, the SDK does not create a usable recording.

## How capture and storage work

The current SDK records a continuous rrweb session stream rather than creating a separate replay only when an error occurs:

1. The SDK reports the browser session to `/api/v1/sessions/init`. The request includes the SDK name and version, release, environment, session id, start time, scrubbed page URL, and any user identity supplied through `setUser()`. The server returns whether recording is allowed. If the SDK supplies an `environment`, ingestion resolves it within the API key's project only when that project's payload override is enabled; otherwise the key environment is used. A session keeps its first accepted environment for its lifetime.
2. The SDK cuts the stream into independently playable chunks. When an error is accepted, it also flushes the current chunk so the incident can point into that same session.
3. The browser gzips each chunk and posts it to ingestion in one authenticated request. Ingestion rejects bodies over 5MiB, writes accepted bytes to private object storage with server-side credentials, and commits the chunk row.
4. A server-side scrubber inflates the chunk under a hard size ceiling, redacts it, rewrites the stored object, and sets `scrubbed_at`.

The browser-side masks described below are the protection applied before upload. Raw gzipped chunks now transit ingestion and are buffered there for validation before they reach object storage. Server-side scrubbing happens afterward, but the raw chunk is fail-closed for application reads: no dashboard, API, or worker read path serves it until scrubbing succeeds and `scrubbed_at` is set. A chunk that never scrubs stays unreadable through the application. This gate does not apply to ingestion process memory or the storage layer itself. Operators and anyone holding the object-storage credentials can access pre-scrub recordings.

See [Your data](../architecture/trust.md) for what leaves your servers.

## What is masked in the browser

- **Every input value** (`maskAllInputs: true`): passwords, emails, card fields, search boxes, and other form values render as masked characters.
- **Text you mark**: add `opslane-mask` to an element whose rendered text should be masked.
- **Subtrees you exclude**: add `opslane-block` to keep an element and its descendants out of the recording entirely.

```html
<div class="opslane-mask">alice@example.com</div>
<section class="opslane-block">Sensitive account details</section>
```

That is the complete browser-side masking list for replay DOM content. The SDK's text and URL scrubbing for error events and console breadcrumbs does **not** run over the serialized replay DOM before upload.

Masking is not anonymization. A recording may include page URLs and titles, visible page text not marked with `opslane-mask`, click and navigation timing, console signals, and network status metadata. Rendered email addresses, invoices, support tickets, and other personal data are captured as displayed unless you mask or block them.

Separately from the DOM recording: if your application calls `setUser()`, the SDK sends that user's id, email, account id, and account name **unmasked** when it registers the session with `/api/v1/sessions/init`, and ingestion persists them to associate recordings with the person who hit an error. Masking never applies to these fields. If you identify users, say so in your privacy notice.

## Session reporting without replay

Turning replay off does not suppress the lightweight session report. This lets Opslane verify that an SDK installation is running without collecting a DOM recording:

```ts
init({
  apiKey: '...',
  replay: { enabled: false },
});
```

To suppress the session-init request itself, use the separate reporting opt-out:

```ts
init({
  apiKey: '...',
  reporting: { enabled: false },
});
```

Replay cannot start without the session-init handshake, so disabling reporting also prevents replay capture. This option controls only the session-init signal; it does not disable error-event delivery.

## Turn recording off

Opt out in one integration:

```ts
init({
  apiKey: '...',
  replay: { enabled: false },
});
```

The SDK still sends the lightweight session report described above. Use `reporting: { enabled: false }` only if you also want to suppress that request.

To stop recording for a whole project without redeploying the application, set `projects.recording_enabled` to `false` through your database or admin tooling. The server then declines new sessions and rejects the next chunk upload for an active session, which tells the SDK to stop its recorder.

## Tell your users

Recording user interactions may require an update to your privacy notice. This sample is only a starting point; adapt it to your jurisdiction and have your own counsel review it:

> We record how you interact with this application (pages viewed, clicks, and
> form interactions) to diagnose errors and fix problems you run into. Values
> you type into forms are masked before the recording leaves your browser.
> Recordings are deleted after 30 days.

Adjust the retention figure to the project's actual `session_retention_days` value, and if you call `setUser()`, disclose that recordings are linked to the signed-in user. The deletion promise holds for the current chunked-session path. If your deployment still accepts legacy one-shot uploads, that path has no automated deletion yet, so schedule your own cleanup before making this promise.

## Retention

Chunked sessions are deleted on a per-project clock. The default is 30 days, configured by `projects.session_retention_days`; deletion removes the Postgres rows and the session's object-storage prefix. Sessions linked as incident evidence can survive the normal window, but every session has a hard 90-day cap. Deleted session IDs are tombstoned and their storage prefixes are swept repeatedly so late uploads cannot recreate retained data.

The **legacy one-shot replay path** remains available for older SDKs and incidents. It rewrites the object with redacted data only when the upload completes, so an interrupted upload can leave raw data in storage, and those `session_replays` rows currently have no automated retention policy. The current SDK's chunked path does not use it.

For the broader data-flow and remaining security gaps, read the [trust and security model](../architecture/trust.md).
