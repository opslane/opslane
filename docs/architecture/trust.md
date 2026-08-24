---
description: What Opslane collects, where it stays, and what each integration sends out.
---

# Your data

Opslane runs on your own servers. Your errors and session recordings stay there. The only data that leaves is what an integration you turn on needs to do its job.

## What Opslane collects

Through the SDK, from your app:

- **Errors**, with tokens and credentials stripped from the text and URLs.
- **Session recordings**, with form inputs masked in the browser before they upload.

If you identify signed-in users with `setUser`, Opslane stores their id and email so it can tell you how many people a bug hit.

## What each integration sends out

You turn these on. Each sends only what it needs:

- **GitHub** — Opslane clones your repository to read your code, and opens pull requests.
- **Anthropic** — the error context and the parts of your code an investigation reads.
- **E2B** — your repository and the commands to test a fix, in an isolated environment.
- **Slack** (optional) — issue titles, summaries, and links.

With no integrations turned on, nothing leaves your servers.

## Recordings are the sensitive part

Session recordings can capture what a user saw on the page. Form inputs are masked before they leave the browser, and you can mask or hide any other element. Recordings are stored privately and deleted on a schedule you set. See [replay privacy](../guides/replay-privacy.md) for how masking works and how to turn recording off.
