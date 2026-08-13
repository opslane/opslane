---
covers:
  - packages/ingestion/notify/dispatcher.go
  - packages/ingestion/handler/notifications.go
  - packages/ingestion/db/notifications.go
  - packages/dashboard/src/components/IntegrationsSettings.vue
description: Send new-issue alerts and the daily digest to Slack with an incoming webhook.
---

# Slack notifications

Opslane posts Slack messages for **new issue alerts** and **daily digests**. Issue alerts fire the first time an error groups into a fresh issue, not on every occurrence. Repeat events of the same issue raise its occurrence count without notifying again, so a noisy error is one message, not a flood.

Delivery goes through a Slack **incoming webhook** you create in your workspace. The webhook URL is the only credential involved; Opslane never needs a Slack bot token or app installation.

## 1. Create the incoming webhook in Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create an app (or open an existing one) in your workspace.
2. Under **Incoming Webhooks**, toggle the feature on.
3. Click **Add New Webhook to Workspace**, pick the channel that should receive notifications, and copy the generated `https://hooks.slack.com/services/...` URL.

Treat that URL as a secret: anyone holding it can post to your channel. Opslane stores it encrypted and never displays it again after you save it.

## 2. Add the destination in Opslane

Dashboard → **Settings** → **Integrations** → *Notification integrations*: add a destination, name it, and paste the webhook URL. Select which event types to receive; by default both new issue alerts and daily digests are enabled. Use the test actions to send samples of each message type and confirm the channel wiring before relying on it.

Or via the API (session-authenticated — an SDK API key cannot manage destinations):

```bash
curl -X POST "https://your-instance/api/v1/projects/$PROJECT_ID/notification-destinations" \
  -H 'Content-Type: application/json' \
  -d '{"name":"#eng-alerts","webhook_url":"https://hooks.slack.com/services/..."}'
```

Omitting `event_types` enables both new issue alerts and daily digests by default; pass `"event_types":["issue.created"]` to receive only issue alerts or `"event_types":["digest.daily"]` for only digests.

The full endpoint set (list, update, delete, test) is in [HTTP routes](../reference/http-routes.md). To test a specific message type, pass `{"event_type":"digest.daily"}` in the test request body; omitting it sends a test issue alert. On cloud multi-org deployments, creating, updating, deleting, and testing destinations requires the **admin** organization role; self-hosted OSS deployments allow any signed-in org member.

## Delivery semantics

- Notifications are published through a transactional outbox: an issue either commits together with its pending deliveries or not at all, so a crash cannot drop or duplicate a notification.
- Failed sends retry with backoff up to 5 attempts, honoring Slack's `Retry-After` on rate limits. Delivery state (`last_delivery`, `recent_failures`) is visible on the destination list.
- Messages include the issue title, project, environment, first-seen time, and a link to the incident. Set `DASHBOARD_URL` so those links point at your reachable dashboard; without it, messages are delivered without a link.
- Issue titles are sanitized before formatting: Slack control sequences (like `@channel`) are neutralized and token-shaped strings are masked.

## Security notes

- Webhook URLs are encrypted at rest with a key derived from `JWT_SECRET`. Rotating `JWT_SECRET` invalidates stored webhook configs, and each destination's URL must be re-entered.
- Every read surface — API responses, dashboard, logs, delivery errors — shows only a redacted fingerprint (`hooks.slack.com/…/****abcd`), never the URL.
- Destinations must use HTTPS `hooks.slack.com` URLs. `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS` extends the allowlist for local development and tests only; never set it in production ([environment variables](../reference/environment-variables.md)).
- What leaves your host, exactly: issue ID and title, first-seen timestamp, project ID and name, and environment name — itemized in [trust](../architecture/trust.md#data-flow-what-leaves-your-host). With no destinations configured, nothing is sent.
