# Owned component consumer matrix

This matrix records direct production imports. A component with no production
consumer is a failed extraction and must not ship. Update this file whenever a
new owned primitive or domain component is added.

| Owned component | Production consumers | Boundary |
|---|---|---|
| `Button.vue` | `views/IncidentDetail.vue` | semantic actions |
| `EmptyState.vue` | `views/IssuesList.vue` | empty issue list |
| `IconButton.vue` | `components/ui/ModalSurface.vue` | icon-only action |
| `InlineAlert.vue` | `views/IssuesList.vue` | route feedback |
| `ModalSurface.vue` | `views/Settings.vue`, `components/layout/NavDrawer.vue` | accessible modal foundation |
| `SelectField.vue` | `views/SessionsList.vue` | labelled select |
| `SkeletonBlock.vue` | `views/IssuesList.vue` | loading placeholder |
| `StatusLabel.vue` | `views/IncidentDetail.vue`, `components/incidents/IssueRow.vue`, `components/incidents/IncidentLifecycle.vue` | typed status signal |
| `TabList.vue` | `views/Settings.vue` | tab semantics |
| `TextInput.vue` | `views/SessionsList.vue` | labelled text input |
| `TextareaField.vue` | `views/IncidentDetail.vue` | labelled textarea |
| `AppNavigation.vue` | `components/layout/AppRail.vue`, `components/layout/NavDrawer.vue` | shared navigation content |
| `AppRail.vue` | `App.vue` | desktop navigation |
| `NavDrawer.vue` | `App.vue` | mobile navigation |
| `EvidenceCheck.vue` | `components/evidence/EvidenceWell.vue` | verification check row |
| `EvidenceWell.vue` | `views/IncidentDetail.vue` | dark evidence surface |
| `ProvenanceFooter.vue` | `components/evidence/EvidenceWell.vue` | evidence provenance |
| `IssueRow.vue` | `views/IssuesList.vue` | issue list row |
| `PriorityReason.vue` | `components/incidents/IssueRow.vue` | why an issue ranks where it does |
| `IncidentConclusion.vue` | `views/IncidentDetail.vue` | outcome and next action |
| `IncidentLifecycle.vue` | `views/IncidentDetail.vue` | truthful current-state summary |
| `PrLinkCard.vue` | `views/IncidentDetail.vue` | fix PR artifact card (linked or plain-text URL) |
| `AttemptReasonCard.vue` | `views/IncidentDetail.vue` | failed-attempt reason and remediation |
| `CandidateDiffCard.vue` | `views/IncidentDetail.vue` | preserved working diff from a failed fix |
| `SessionLedgerRow.vue` | `views/SessionsList.vue` | session list row |
| `layout/navigation.ts` | `components/layout/AppNavigation.vue` | navigation model and active-route rule |
| `session.ts` | `App.vue` | tenant-scoped client state teardown on sign-out |

Existing specialized components outside the new owned directories remain
feature components, not public design-system primitives. If `components/ui/`,
`components/layout/`, or `components/evidence/` is introduced, every exported
file must receive a non-empty row here in the same change.
