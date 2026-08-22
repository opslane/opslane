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
  state?: string;
  episode_id?: string | null;
  root_cause?: string | null;
  pr_url?: string | null;
  signal_type?: string | null;
  element_selector?: string | null;
  page_url_normalized?: string | null;
  investigation_readiness?: 'eligible' | 'ineligible' | 'pending';
  watchable_session?: { session_id: string; anchor_ms: number };
}

export interface DigestCard {
  episode_id: string;
  incident_id: string;
  title: string;
  label: string;
  copy: string;
  action: string;
  affected_users: number;
  accounts: string[];
  pr_url?: string;
}

export interface LatestDigest {
  run_date: string | null;
  cards: DigestCard[];
}

export interface EvidenceFrame {
  anchor_kind: string;
  status: string;
  envelope: unknown;
  commit_sha: string | null;
}

export interface EvidenceFailedRequest {
  page_route: string;
  method: string;
  endpoint_pattern: string;
  status: number;
  action_selector: string | null;
}

export interface EvidenceReplayPointer {
  anchor_kind: string;
  session_id: string;
  anchor_ms: number;
}

export type RecordingAvailability = 'available' | 'partial' | 'expired' | 'missing';
export type SourceMapStatus = 'resolved' | 'no_map' | 'failed' | 'pending' | 'missing';

export interface IssueEvidence {
  frames: EvidenceFrame[];
  failed_requests: EvidenceFailedRequest[];
  replay_pointers: EvidenceReplayPointer[];
  availability: {
    recording: RecordingAvailability;
    source_map: SourceMapStatus;
  };
}
