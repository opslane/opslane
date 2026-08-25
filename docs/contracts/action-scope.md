---
description: What environment action scoping gates, and what it deliberately does not.
---
# Environment action scope

Projects may limit automatic error investigation to selected environments. The scope is an admission rule, not an ingestion rule.

Every accepted error is still stored as an observation, sent through stack resolution, and assigned to a stable project issue. Occurrence counts and environment breakdowns also continue to update. When Opslane decides whether an error issue has enough recent impact to enter repository inquiry, however, it counts only evidence from allowed environments.

An issue with only out-of-scope evidence stays watched. A later observation from an allowed environment can make it eligible for inquiry. Ranking and admission remain separate decisions.

## Project API

Project responses include:

- `action_scope_enabled: boolean`
- `action_environment_ids: string[]`

`PATCH /api/v1/projects/{projectID}` accepts an `action_environment_ids` field with three useful forms:

- Omit the field to leave the setting unchanged.
- Send `null` to disable scoping and clear the list.
- Send an array to enable scoping and replace the list.

An empty array enables a fail-closed scope, so no environment can admit an error issue to automatic inquiry. IDs must name environments in the same project. Validation is atomic with the rest of the settings update.

Deleting an allowed environment removes it from the list but does not disable scoping. If that leaves the list empty, automatic error inquiry remains off until the project settings change.

## What the scope does not cover

The scope gates automatic error inquiry and investigation only. It does not gate:

- event capture, stack resolution, issue identity, or counts;
- session recording or session analysis;
- friction detection, investigation, or its approval and autonomy rules;
- a fix that a person explicitly starts from an eligible analysis.

This boundary matters because friction follows its own evidence and approval path. Calling the setting "automatic error investigation" keeps that distinction visible.
