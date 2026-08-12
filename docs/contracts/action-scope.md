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

Every automatically enqueued or requeued error-group job stores the triggering
`event_id`; the worker's automatically created fix job inherits its source
investigation's anchor. Human-guided fix jobs bypass the action scope and anchor
to the group's current sample event. Workers prefer the job anchor and fall back
to `sample_event_id` for historical jobs or anchors removed by retention.

## What the scope does not cover

The action scope gates the error-investigation pipeline only. Session recording,
session closing, and `session_analysis` jobs — including any friction incidents
and fix PRs the friction pipeline produces under the project's autonomy setting
— run for every environment regardless of scope. Gating session automation by
environment is follow-up work; until then the settings surface says "automatic
error investigation", not "automation", deliberately.

The dashboard's `sample_event_id` display semantics are unchanged. A filtered
incident read can therefore still show a sample from another environment; this
is a known first-version limitation.

## Deployment order

Commit order is not safe rollout order:

1. Evidence anchoring: deploy migration 046, then the NULL-tolerant worker, then
   ingestion that stamps `event_id`.
2. Action scope: deploy migration 047, then gate-bearing ingestion everywhere,
   then expose the settings PATCH and dashboard UI.

Do not let customers configure a scope while any ingest instance can ignore it.
Scoped priority and the affected-users environment dimension are S4 follow-up
work and are intentionally outside this contract.
