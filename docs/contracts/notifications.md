---
description: Which issue events notification destinations receive and when Opslane publishes them.
---

# Notification events

Notification destinations can subscribe to issue notifications and daily digests. Issue destinations choose between immediate and post-triage delivery, but the current settled-identity error path does not publish an immediate issue-created event. Capturing an observation never sends an alert.

Notification configuration encryption binds each ciphertext to its destination ID, project ID, and stored destination type. The current endpoints and database constraint admit only `slack`. Adding another type requires a new migration that widens the constraint and type-specific configuration validation; applied migrations must not be edited.

Choose post-triage delivery when you want a message after an error investigation opens a pull request or stops for a person. Insights and decisions not to pursue appear in the daily digest instead. Daily digests summarize activity over a window rather than posting once per captured occurrence.

## Post-triage payload

The versioned `issue.triaged` envelope identifies the issue, project, environment, dashboard URL, terminal outcome, and recent impact. Labels come from a fixed formatter table. The payload does not include model-written root-cause or reason text, which keeps untrusted prose out of Slack and generic webhooks.

Publishing uses a transactional outbox. When Opslane publishes an event, it commits the event and its destination deliveries with the related state change. Delivery workers can then retry without losing the notification or sending a second logical message for the same completed job. A reopened issue can notify again after new work reaches a new outcome.

`issue.triaged` is an internal formatter and outbox event, not a selectable subscription name. Destinations continue to subscribe to issue notifications and use their delivery policy to select timing.

## `digest.daily` schema v4

Schema v4 adds grounded, model-written cards to the version 1 event envelope:

```json
{
  "version": 1,
  "event_type": "digest.daily",
  "digest": {
    "schema_version": 4,
    "date": "2026-08-24",
    "generated_cards": [
      {
        "episode_id": "...",
        "incident_id": "...",
        "title": "Send invoice does nothing",
        "outcome": "needs_human",
        "copy": "18 people tried to send an invoice and couldn't. The request stopped before saving.",
        "action": "Watch the replay and choose whether to retry.",
        "affected_users": 18,
        "occurrence_count": 34,
        "accounts": ["Northwind Traders"],
        "replay_url": "https://.../sessions/...?t=4200"
      }
    ]
  }
}
```

The publisher derives IDs, outcomes, counts, accounts, replay URLs, and pull
request fields from each frozen candidate. It rejects unsupported numbers in a
card's title, copy, or action. The writer supplies only the title, copy, and
action.

Slack renders `needs_human` cards under **Needs a decision** and `verified_fix`
cards under **Fixes ready to merge**. Each card uses native buttons for an
available replay or pull request and for the issue page. The renderer shows at
most nine cards, gives decision cards priority, and links to the dashboard when
more cards remain. Stored schema versions 1 through 3 keep their original
renderers.
