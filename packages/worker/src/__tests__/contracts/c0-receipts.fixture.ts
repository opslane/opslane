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
