/** The subset of the incident response these tools read. Deliberately a local
 * declaration: @opslane/shared is private and unpublished, so the CLI cannot
 * depend on it. Keep the field names identical to the API. */
export interface McpIncident {
  id: string;
  kind: string;
  title: string;
  status: string;
  occurrence_count: number;
  affected_users_count: number;
  first_seen: string;
  last_seen: string;
  signal_type?: string | null;
  element_selector?: string | null;
  page_url_normalized?: string | null;
  investigation_readiness?: 'eligible' | 'ineligible' | 'pending';
  watchable_session?: { session_id: string; anchor_ms: number };
}
