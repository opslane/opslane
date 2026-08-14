---
description: Notification subscription, delivery-policy, and internal outbox event contracts.
---

# Notification events

Notification destinations subscribe to `issue.created` and/or `digest.daily`.
`issue.triaged` is an internal outbox and formatter event, not a selectable
subscription.

For an `issue.created` subscription, `delivery_policy` controls delivery time:

- `immediate` (the default) delivers `issue.created` when automation first
  enqueues a new group.
- `post_triage` suppresses that ingest-time delivery and delivers one
  `issue.triaged` message when the group transitions to `needs_human` or
  `pr_created`.

`insight` and `not_actionable` outcomes do not produce `issue.triaged`; they are
reported through the daily digest. Changing delivery policy does not change the
destination's `issue.created` subscription.

## `issue.triaged` payload

The version 1 envelope contains the issue, project, environment, dashboard URL,
and a templated `outcome`:

```json
{
  "version": 1,
  "event_type": "issue.triaged",
  "issue": { "id": "...", "title": "...", "first_seen": "..." },
  "project": { "id": "...", "name": "..." },
  "environment": "production",
  "dashboard_url": "https://...",
  "outcome": {
    "status": "needs_human",
    "reason_code": "insufficient_context",
    "label": "Needs review — no verified cause",
    "impact": { "users_7d": 2, "anon_sessions_7d": 3 }
  }
}
```

The payload never includes model-written `reason_message` or `root_cause` text.
Labels come from a fixed table keyed by terminal status and reason code, so a
successful PR is always announced as `Fix PR opened`.

The deduplication key is
`issue.triaged:<group-id>:<terminal-job-id>`. Retrying the same terminal job
therefore delivers once, while a reopened regression with a new job can notify
again.
