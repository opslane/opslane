---
description: What environment action scoping gates, and what it deliberately does not.
---
# Environment action-scope contract

Projects may limit automatic error investigation to selected environments. Error
group identity remains `(project_id, fingerprint)`: environment is a dimension,
not part of grouping identity. All accepted events, environment rollups, affected
users, and the mutable `sample_event_id` continue to update even when an event is
outside the action scope.

## Project API

Project list, create, onboarding, and settings responses always include:

- `action_scope_enabled: boolean`
- `action_environment_ids: string[]` (an empty JSON array, never `null`)

`PATCH /api/v1/projects/{projectID}` accepts the tri-state
`action_environment_ids` field:

- omitted: leave the action scope unchanged;
- `null`: disable scoping and clear the allowlist;
- `[]`: enable scoping with an empty allowlist, disabling automatic investigation
  for every environment;
- an array of environment UUIDs: enable scoping and replace the allowlist.

Duplicate IDs collapse to one membership. A malformed UUID or an environment
that does not belong to the target project returns `400`. The settings PATCH is
atomic: validation failure also rolls back other fields in the same request.

Enabled scope is fail-closed. Deleting an environment cascades its allowlist
membership but does not disable the project's scope; deleting the last allowed
environment therefore turns off automatic investigation until settings change.

## Ingestion and job evidence

An event outside the scope may create a group in `new`, but it creates no job and
no `issue.created` outbox event. The first later in-scope occurrence activates
that dormant group: it creates one investigation job, moves the group to `queued`,
and publishes `issue.created`. Thus `issue.created` means the first automation
enqueue, not necessarily the group's first stored occurrence. Out-of-scope
occurrences cannot requeue `resolved`, `merged`, or retriable `needs_human`
groups. Existing release-order and non-retriable-reason gates still apply after
the environment gate.

Every admitted error investigation stores its work-round `episode_id`. An
automatically created fix inherits its source investigation's episode and
frozen anchors. A human-guided error fix inherits the latest completed
investigation in the open episode. Error investigation and fix jobs fail when
that episode is absent; they never select mutable evidence through
`sample_event_id`. The friction pipeline retains its existing evidence
selection until its admission path moves to work rounds.

## What the scope does not cover

The action scope gates the error-investigation pipeline only. Session recording,
session closing, and `session_analysis` jobs — including any friction incidents
and fix PRs the friction pipeline produces under the project's autonomy setting
— run for every environment regardless of scope. Gating session automation by
environment is follow-up work; until then the settings surface says "automatic
error investigation", not "automation", deliberately.

Affected-user counts are likewise not environment-scoped (the S4 deferral):
out-of-scope occurrences still record identified users, and the auto-fix
policy's impact bar reads those counts. An out-of-scope occurrence therefore
cannot start or restart automation, but it can contribute to the impact
evidence an in-scope investigation's fix policy consults. Scoping the impact
dimension by environment is part of the S4 follow-up.

The dashboard's `sample_event_id` display semantics are unchanged. A filtered
incident read can therefore still show a sample from another environment; this
is a known first-version limitation.

## Deployment order

Commit order is not safe rollout order:

1. Evidence anchoring: deploy migration 048, then the NULL-tolerant worker, then
   ingestion that stamps `event_id`.
2. Action scope: deploy migration 049, then gate-bearing ingestion everywhere,
   then expose the settings PATCH and dashboard UI.

Do not let customers configure a scope while any ingest instance can ignore it.
Scoped priority and the affected-users environment dimension are S4 follow-up
work and are intentionally outside this contract.
