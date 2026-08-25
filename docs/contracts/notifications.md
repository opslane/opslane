---
description: Which issue events notification destinations receive and when Opslane publishes them.
---

# Notification events

Notification destinations can subscribe to issue notifications and daily digests. Issue destinations choose between immediate and post-triage delivery, but the current settled-identity error path does not publish an immediate issue-created event. Capturing an observation never sends an alert.

Choose post-triage delivery when you want a message after an error investigation opens a pull request or stops for a person. Insights and decisions not to pursue appear in the daily digest instead. Daily digests summarize activity over a window rather than posting once per captured occurrence.

## Post-triage payload

The versioned `issue.triaged` envelope identifies the issue, project, environment, dashboard URL, terminal outcome, and recent impact. Labels come from a fixed formatter table. The payload does not include model-written root-cause or reason text, which keeps untrusted prose out of Slack and generic webhooks.

Publishing uses a transactional outbox. When Opslane publishes an event, it commits the event and its destination deliveries with the related state change. Delivery workers can then retry without losing the notification or sending a second logical message for the same completed job. A reopened issue can notify again after new work reaches a new outcome.

`issue.triaged` is an internal formatter and outbox event, not a selectable subscription name. Destinations continue to subscribe to issue notifications and use their delivery policy to select timing.
