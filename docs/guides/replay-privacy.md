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

Session recording shows what a user saw and did around an error. It is the most privacy-sensitive thing Opslane collects, and it is on by default. This page covers what is recorded, how masking works, and how to turn it off.

## What is masked, and what is not

Every form input is masked before the recording leaves the browser: passwords, emails, card fields, search boxes. Those values never reach Opslane's servers. You can mask or hide anything else:

- Add `opslane-mask` to an element to mask its text.
- Add `opslane-block` to keep an element and everything inside it out of the recording.

```html
<div class="opslane-mask">alice@example.com</div>
<section class="opslane-block">Sensitive account details</section>
```

Masking is not anonymization. A recording still includes page URLs and titles, any visible text you did not mask, clicks, and network status. Email addresses, invoices, and support tickets on the page are captured as shown unless you mask or block them.

If you call `setUser`, the user's id and email are sent unmasked, so Opslane can tell you who a bug hit. If you identify users, say so in your privacy notice.

## Turn recording off

For one app, opt out in the SDK:

```ts
init({ apiKey: '...', replay: { enabled: false } });
```

To stop recording for a whole project without redeploying, turn the project's recording switch off in the dashboard. The server then refuses new recordings and tells the SDK to stop.

## How long recordings live

Recordings are deleted on a schedule you set, 30 days by default. Deletion removes both the stored recording and its database rows. A recording attached to an issue as evidence can last longer, but never more than 90 days.

## Tell your users

Recording interactions may mean updating your privacy notice. This is a starting point; adapt it and have your own counsel review it:

> We record how you interact with this application (pages viewed, clicks, and form interactions) to diagnose errors and fix problems you run into. Values you type into forms are masked before the recording leaves your browser. Recordings are deleted after 30 days.

Match the retention figure to your setting, and if you call `setUser`, disclose that recordings are linked to the signed-in user.

See [Your data](../architecture/trust.md) for everything Opslane collects and where it goes.
