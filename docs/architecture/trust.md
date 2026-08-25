---
covers:
  - packages/sdk/src/scrub.ts
  - packages/worker/src/repo-clone.ts
  - packages/ingestion/notify/slack.go
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

You turn these on. Each one sends only what it needs to do its job:

- **GitHub:** Opslane clones your repository to read your code and open pull requests.
- **Anthropic:** the error, and the parts of your code Opslane reads while investigating it.
- **E2B:** the sandbox where a fix is tested. It gets your repository and the commands to run your tests.
- **Slack** (optional): issue titles, summaries, and links.
- **MCP:** a coding agent you connect can read your issues and their evidence, and link a pull request.

Investigating and fixing bugs is the point, so in normal use Opslane does send this data to GitHub, Anthropic, and E2B. What it never does is phone home or call any service you haven't connected. There is no Opslane telemetry.

## Recordings are the sensitive part

Session recordings can capture what a user saw on the page. Form inputs are masked before they leave the browser, and you can mask or hide any other element. Recordings are stored privately and deleted on a schedule you set. See [replay privacy](../guides/replay-privacy.md) for how masking works and how to turn recording off.
