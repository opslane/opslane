---
covers:
  - packages/ingestion/notify/dispatcher.go
  - packages/ingestion/handler/notifications.go
  - packages/ingestion/db/notifications.go
  - packages/dashboard/src/components/IntegrationsSettings.vue
  - packages/dashboard/src/views/SetupWizard.vue
description: Send issue alerts after Opslane decides what to do and send the daily summary to Slack with an incoming webhook.
---

# Slack notifications

Opslane posts Slack messages for **issue alerts** and **daily digests**. You get one alert per issue, sent after Opslane has decided what to do with it (opened a fix pull request, or stopped for a person), not one message every time the bug happens. A noisy bug is one alert, not a flood.

Delivery goes through a Slack **incoming webhook** you create in your workspace. The webhook URL is the only credential involved; Opslane never needs a Slack bot token or app installation.

## 1. Create the incoming webhook in Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create an app (or open an existing one) in your workspace.
2. Under **Incoming Webhooks**, toggle the feature on.
3. Click **Add New Webhook to Workspace**, pick the channel that should receive notifications, and copy the generated `https://hooks.slack.com/services/...` URL.

Treat that URL as a secret: anyone holding it can post to your channel. Opslane stores it encrypted and never displays it again after you save it.

## 2. Add the destination in Opslane

<!-- voice-ok: "Alert after triage" is the exact dashboard setting label and is defined here. -->
Dashboard > **Settings** > **Integrations** > *Notification integrations*: add a destination, name it, and paste the webhook URL. Select which event types to receive; by default both issue alerts and daily digests are enabled. Choose **Alert after triage**, which waits until Opslane decides whether to fix the issue or hand it to a person. Use the test actions to confirm the channel wiring before relying on it.

The onboarding wizard configures a daily digest safely: it creates the destination disabled, sends a test issue alert, and enables the destination only when Slack accepts the test. A failed test leaves the destination disabled, and retrying updates the same row. You can also choose **Do this later**; the dashboard keeps a Slack reminder visible until an enabled daily-digest destination exists.

Or via the API (session-authenticated; an SDK API key cannot manage destinations):

```bash
curl -X POST "https://your-instance/api/v1/projects/$PROJECT_ID/notification-destinations" \
  -H 'Content-Type: application/json' \
  -d '{"name":"#eng-alerts","webhook_url":"https://hooks.slack.com/services/...","enabled":false,"event_types":["digest.daily"],"delivery_policy":"post_triage"}'
```

Test the returned destination ID with `POST /api/v1/projects/{projectID}/notification-destinations/{destID}/test`. Patch `enabled` to `true` only when the response contains `"ok":true`.

Omitting `event_types` enables both new issue alerts and daily digests by default; pass `"event_types":["issue.created"]` to receive only issue alerts or `"event_types":["digest.daily"]` for only digests.

Omitting `delivery_policy` defaults to `immediate`. `post_triage` still uses the
`issue.created` subscription; it is a timing policy, not another event checkbox.
It sends when Opslane hands the issue to a person or opens a fix pull request. Findings with no application-code cause and decisions not to pursue remain in the daily digest and do not page the channel.

The full endpoint set (list, update, delete, test) is in [HTTP routes](../reference/http-routes.md). To test a specific message type, pass `{"event_type":"digest.daily"}` in the test request body; omitting it sends a test issue alert. Test digests use a legacy format; scheduled digests use the current format. On cloud multi-org deployments, creating, updating, deleting, and testing destinations requires the **admin** organization role; self-hosted OSS deployments allow any signed-in org member.

## Delivery semantics

- Opslane saves the notification and related issue change in one transaction.
- It sends after the investigation finishes. Retries do not duplicate the alert, but a reopened issue can alert again after new work finishes.
- Failed sends retry with backoff and honor Slack's `Retry-After` response on rate limits. Delivery state (`last_delivery`, `recent_failures`) is visible on the destination list.
- Messages include the issue title, project, environment, first-seen time, and a link to the incident. Set `DASHBOARD_URL` so those links point at your reachable dashboard; without it, messages are delivered without a link.
- Issue titles are sanitized before formatting: Slack control sequences (like `@channel`) are neutralized and token-shaped strings are masked.

## Security notes

- Webhook URLs are encrypted at rest with a key derived from `JWT_SECRET`. Rotating `JWT_SECRET` invalidates stored webhook configs, and each destination's URL must be re-entered.
- Every place that shows the URL, including API responses, the dashboard, logs, and delivery errors, shows only a masked preview (`hooks.slack.com/…/****abcd`), never the full URL.
- Destinations must use HTTPS `hooks.slack.com` URLs. `NOTIFY_UNSAFE_EXTRA_WEBHOOK_HOSTS` extends the allowlist for local development and tests only; never set it in production ([environment variables](../reference/environment-variables.md)).
- What leaves your host, exactly: issue ID and title, first-seen timestamp, project ID and name, and environment name, itemized in [Your data](../architecture/trust.md). With no destinations configured, nothing is sent.
