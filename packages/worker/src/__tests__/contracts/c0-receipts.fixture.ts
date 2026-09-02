import type { DigestReceiptFields, ReceiptItem } from '@opslane/shared';

export const receiptItem: ReceiptItem = {
  kind: 'error',
  incident_id: 'incident-1',
  title: 'Sign-in page crashes',
  occurrence_count: 3,
  impact_class: 'blocked',
  impact_visits: 2,
  impact_visits_recovered: 1,
  receipt_state: 'pr_open',
  pr_url: 'https://github.com/opslane/opslane/pull/1',
  session_url: 'https://app.opslane.com/sessions/session-1',
  root_cause_excerpt: 'The authentication wrapper renders an unresolved component.',
  mitigation_excerpt: 'Render the fallback until the async component resolves.',
  has_saved_diff: true,
  cluster_incident_ids: [],
};

export const digestReceiptFields: DigestReceiptFields = {
  schema_version: 2,
  receipt_items: [receiptItem],
};

export const digestReceiptFieldsV2: DigestReceiptFields = {
  schema_version: 2,
  receipt_items: [receiptItem],
  triage_counts: { prs_awaiting_review: 0, needs_decision: 0 },
  held_back_count: 2,
  receipt_overflow: 4,
};

export const digestReceiptFieldsV4: DigestReceiptFields = {
  schema_version: 4,
  timezone: 'America/Los_Angeles',
  generated_cards: [{
    episode_id: 'episode-1', incident_id: 'incident-1', title: 'Sign-in crashes',
    label: 'new', outcome: 'needs_human', copy: 'Sign-in fails.', action: 'Choose the fallback.',
    affected_users: 3, occurrence_count: 7, accounts: ['Acme'], pr_number: 9,
    impact_visits: 17, impact_visits_recovered: 14,
  }],
  receipt_items: [{ ...receiptItem, has_validated_diagnosis: true, actionable_since: '2026-08-27T10:00:00Z' }],
  receipt_overflow: 1,
  overflow_count: 2,
  delivery_alert: 'Actionable lane degraded.',
};
