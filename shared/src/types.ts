// === Tenant model ===

export interface Org {
  id: string;
  name: string;
  created_at: string;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  github_repo: string;
  default_branch: string;
  pr_posture: PRPosture;
  allow_payload_environment: boolean;
  created_at: string;
}

// === Digest receipt payload ===

export interface ReceiptItem {
  kind: string;
  incident_id: string;
  title: string;
  occurrence_count: number;
  impact_class?: string;
  impact_visits?: number;
  impact_visits_recovered?: number;
  receipt_state: string;
  pr_url?: string;
  session_url?: string;
  root_cause_excerpt?: string;
  mitigation_excerpt?: string;
  has_saved_diff?: boolean;
  /** Whether the item's diagnosis was validated. Digest copy reads this
   *  directly rather than inferring a cause from root_cause_excerpt. */
  has_validated_diagnosis?: boolean;
  cluster_incident_ids?: string[];
  /** Go source: notify.ReceiptItem.ActionableSince. */
  actionable_since?: string;
}

/** Go source: notify.GeneratedDigestCard. */
export interface GeneratedDigestCard {
  episode_id: string;
  incident_id: string;
  title: string;
  label: string;
  outcome?: string;
  copy: string;
  action: string;
  affected_users: number;
  occurrence_count?: number;
  accounts: string[];
  pr_url?: string;
  replay_url?: string;
  pr_number?: number;
}

/** Versioned fields from Go's notify.DigestPayload. */
export interface DigestReceiptFields {
  schema_version?: number;
  receipt_items?: ReceiptItem[];
  triage_counts?: {
    prs_awaiting_review: number;
    needs_decision: number;
  };
  held_back_count?: number;
  receipt_overflow?: number;
  generated_cards?: GeneratedDigestCard[];
  overflow_count?: number;
  delivery_alert?: string;
  timezone?: string;
}

export interface Environment {
  id: string;
  project_id: string;
  name: string; // e.g. "production", "staging"
  created_at: string;
}

// === User (session auth) ===

export interface User {
  id: string;
  org_id: string;
  email: string;
  name: string;
  created_at: string;
}

// === SDK → Ingestion payload ===

export interface DebugImage {
  type: 'sourcemap';
  code_file: string;
  debug_id: string;
}

export interface DebugMeta {
  images?: DebugImage[];
}

export interface ErrorEventPayload {
  timestamp: string; // ISO 8601
  platform?: 'javascript' | 'python';
  runtime?: {
    name: string;
    version: string;
  };
  error: {
    type: string;
    message: string;
    stack: string;
  };
  breadcrumbs: Breadcrumb[];
  context: {
    url?: string;
    user_agent?: string;
    request?: {
      method: string;
      path: string;
      headers: Record<string, string>;
      remote_addr?: string;
    };
    user?: {
      id: string;
      email?: string;
      account_id?: string;
      account_name?: string;
    };
  };
  sdk_version: string;
  release?: string;      // source map lookup
  commit_sha?: string;   // build provenance
  debug_meta?: DebugMeta;
  network_timings?: NetworkTiming[];  // observed request timing; omitted when empty
  session_id?: string;   // links error event to replay
  environment?: string;  // project-scoped environment name override
}

export interface Breadcrumb {
  type: BreadcrumbType;
  timestamp: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
  level?: 'debug' | 'info' | 'warning' | 'error';
}

export type BreadcrumbType =
  | 'error'
  | 'fetch'
  | 'xhr'
  | 'console'
  | 'click'
  | 'navigation'
  | 'http'
  | 'log';

/**
 * One observed browser request, attached to an error event.
 *
 * `ttfb_ms` is the cross-transport comparable field: fetch resolves at
 * response headers while XHR `loadend` fires after the transfer completes,
 * so `duration_ms` means different things per transport and `transport`
 * records which. `ttfb_ms` absent on a `timeout` means no headers ever
 * arrived; present means the server responded and the body stalled.
 */
export interface NetworkTiming {
  transport: 'fetch' | 'xhr';
  method: string;
  url: string;
  started_at_ms: number;
  duration_ms: number;
  ttfb_ms?: number;
  outcome: 'ok' | 'http_error' | 'timeout' | 'abort' | 'network_error' | 'in_flight';
  status?: number;
}

// === Error group statuses ===

export type ErrorGroupStatus =
  | 'new'
  | 'queued'
  | 'analyzing'
  | 'investigated'
  | 'fixing'
  | 'pr_created'
  | 'pr_draft'
  | 'needs_human'
  | 'resolved'
  | 'merged'
  | 'archived'
  // Friction lifecycle (epic #31 Batch 3, design v4-4/v4-10):
  | 'candidate' // Adjudication pending; hidden from every list/read API.
  | 'awaiting_approval' // Code cause found; parked for a human; fix-eligible.
  | 'insight'; // No code cause; terminal; never becomes a PR.

// === Reason contract for needs_human ===

export interface NeedsHumanReason {
  reason_code: ReasonCode;
  reason_message: string;
  remediation: string;
}

export type ReasonCode =
  | 'missing_github_token'
  | 'repo_access_denied'
  | 'empty_repository'
  | 'invalid_default_branch'
  | 'unresolvable_head'
  | 'token_decrypt_failed'
  | 'auth_invalid'
  | 'policy_blocked'
  | 'missing_llm_key'
  | 'malformed_diff'
  | 'verification_failed'
  | 'sourcemap_unresolved'
  | 'artifact_fetch_failed'
  | 'insufficient_context'
  | 'worker_runtime_error'
  | 'lease_lost'
  | 'budget_exhausted'
  | 'tests_failed'
  | 'low_confidence_fix'
  | 'repro_not_achievable'
  | 'verification_infra_error'
  | 'draft_cap_reached'
  | 'triage_unfixable'
  | 'unfixable_no_app_frames'
  | 'unfixable_test_error'
  | 'unfixable_third_party'
  | 'unfixable_infra'
  | 'unfixable_no_sourcemap'
  | 'dependency_install_failed';

// === Verification evidence (evidence-tiered fix verification) ===

/** Highest verification tier fully achieved. E0=build, E1=suite vs pre-patch baseline, E2=repro red→green. */
export type EvidenceTier = 'E0' | 'E1' | 'E2';

/**
 * Outcome taxonomy for any verification check.
 * infra_error is retriable and is never evidence about the patch.
 */
export type CheckOutcome = 'passed' | 'failed' | 'skipped_no_runner' | 'infra_error';

export interface EvidenceCheck {
  /** 'build' | 'suite_baseline' | 'suite_post_patch' | 'repro_red' | 'repro_green' | 'repro_reversal' */
  name: string;
  outcome: CheckOutcome;
  command: string;
  exit_code?: number;
  /** Bounded tail of combined stdout/stderr, secrets scrubbed. */
  output_tail: string;
}

export interface EvidenceRecord {
  version: 1 | 2;
  tier: EvidenceTier | null;
  /** Chronological; a retried check appears multiple times and the last entry per name is current. */
  checks: EvidenceCheck[];
  /** Per-test baseline comparison. Pre-existing failures are excluded from the gate. */
  suite?: {
    baseline_failed_tests: string[];
    new_failures: string[];
  };
  /** Reproduction-gate details reserved for Phase 2. */
  repro?: {
    content_hash: string;
    asserts_behavior: boolean;
    path: string;
  };
  /** GitHub CI observed for the exact commit published by Opslane. */
  external_ci?: ExternalCIEvidence;
  /** Mechanical C2 verification grade. */
  tier_record?: {
    tier: 'reproduced' | 'checked' | 'attempted';
    declared_test: { identifier: string; expected_assertion: string } | null;
    reproduction_impossible_reason: string | null;
  };
  /** Diagnosis decision that authorized this attempt. */
  authorization?: {
    decision_id: string | null;
    source: 'source_job' | 'newest_fallback' | 'human_bypass';
    policy_eligible: boolean | null;
  };
  /** Developer-facing verification judge report. */
  judge?: {
    approved: boolean;
    assessment: string;
    veto_reason: string | null;
    session_id: string;
    probes_used: number;
    decision_id: string | null;
  };
}

export type ExternalCIOutcome =
  | 'passed'
  | 'failed'
  | 'no_ci_observed'
  | 'head_moved'
  | 'permission_denied';

export interface ExternalCIEvidence {
  outcome: ExternalCIOutcome;
  pr_number: number;
  head_sha: string;
  check_names: string[];
  failing_checks?: string[];
  observed_at: string;
}

// === Confidence ===

export type ConfidenceLevel = 'high' | 'medium' | 'low';

// === Incident (read API response) ===

export type IncidentKind = 'error' | 'friction';
export type FrictionSignalType = 'rage_click' | 'dead_click' | 'form_abandon';
export type IssuePipelineState =
  | 'processing'
  | 'watching'
  | 'reviewing_evidence'
  | 'waiting_for_evidence'
  | 'investigating'
  | 'fix_ready'
  | 'needs_you'
  | 'reviewed_not_pursuing'
  | 'inactive'
  | 'resolved';

// === Friction adjudication (Batch 4, issue #56) ===

/** Signal-level verdict lifecycle. 'unchecked' = the adjudicator dead-lettered
 * before finishing; diagnostic only — an unchecked signal never folds, never
 * counts toward the promotion threshold, and never becomes fix-eligible. */
export type AdjudicationStatus = 'pending' | 'accepted' | 'rejected' | 'unchecked';
/** Which path adjudicated a signal: an eager same-session fold check, or a
 * bucket-level call at the five-user promotion threshold. */
export type AdjudicationScope = 'fold' | 'bucket';

export interface PriorityInputs {
  users_7d: number;
  anon_sessions_7d: number;
  users_24h: number;
  anon_sessions_24h: number;
  impact: number;
  route_pattern: string | null;
  route_name: string | null;
  route_tier: 'customer' | 'standard' | 'admin' | null;
  route_weight: number;
  cap_applied: boolean;
  reason_code: string | null;
}

export interface Incident {
  id: string;
  project_id: string;
  kind: IncidentKind;
  /** Platform wire token ('javascript', 'python', future tokens) for error
   * incidents; null/absent for friction. */
  platform?: string | null;
  /** Present only on kind='friction': friction identity is environment-scoped. */
  environment_id?: string;
  /** Present only on kind='friction'; 'unchecked' flags an exhausted
   * adjudication surfaced as a non-fixable diagnostic. */
  adjudication_status?: AdjudicationStatus;
  /** Present only on kind='friction': which detector raised this. */
  signal_type?: string | null;
  /** Present only on kind='friction': the clicked element's selector. Positional
   * parts and hashed classes are not stable across builds. */
  element_selector?: string | null;
  /** Present only on kind='friction': the templated route, e.g. '/assets/:id/edit'. */
  page_url_normalized?: string | null;
  /** A session whose scrubbed chunks span the playback window. anchor_ms is
   * absolute client-clock epoch milliseconds, the dashboard's ?t= contract.
   * Unlike `recordings`, this is populated for friction incidents. */
  watchable_session?: { session_id: string; anchor_ms: number };
  fingerprint: string;
  title: string;
  status: ErrorGroupStatus;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  affected_users_count: number;
  priority_score?: number;
  priority_inputs?: PriorityInputs;
  priority_scored_at?: string;
  environments?: Array<{
    id: string;
    name: string;
    occurrence_count: number;
    last_seen: string;
  }>;
  confidence?: ConfidenceLevel;
  pr_url?: string;
  replay_id?: string;
  /** Pointer into the always-on recording for this incident occurrence. */
  session_pointer?: { session_id: string; error_at: string };
  reason?: NeedsHumanReason;
  root_cause?: string;
  investigation_readiness?: 'eligible' | 'ineligible' | 'pending';
  /** Model-authored technical report; render only under an investigation-output label. */
  agent_task_brief?: string;
  /** Structured verification evidence for the latest fix attempt. */
  verification_evidence?: EvidenceRecord;
  /** Candidate diff preserved on needs_human for manual review. */
  candidate_diff?: string;
  impact_class?: 'blocked' | 'degraded' | 'invisible';
  impact_visits?: number;
  impact_visits_recovered?: number;
  story: string;
  receipt_state?: 'pr_open' | 'attempt_failed_with_diff' | 'attempt_failed_no_diff' | 'report_ready';
  receipt_line?: string;
  recordings?: IncidentRecording[];
  visual_summary?: string;
  merged_at?: string;
  resolved_at?: string;
  archived_at?: string;
  /** Customer-facing state derived from the current issue round. */
  state?: IssuePipelineState;
  /** Explanation paired with state. Named separately from the structured fix-attempt reason. */
  state_reason?: string;
  episode_id?: string;
  state_decided_at?: string;
  evidence_event_ids?: string[];
  pending_identity?: boolean;
}

export interface IncidentRecording {
  session_id: string;
  started_at: string;
  /** Recorded span in ms, gaps included. */
  duration_ms: number;
  crash_count: number;
  anchor_ms: number;
}

/** Sample event for an error group, served by
 * GET /projects/{projectId}/incidents/{incidentId}/sample-event. */
export interface SampleEvent {
  timestamp: string;
  platform: string;
  error: {
    type: string;
    message: string;
    stack: string;
  };
  /** The read API normalizes non-array stored values to an empty array. */
  breadcrumbs: unknown[];
  context: Record<string, unknown>;
}

// === Source map upload ===

export interface SourceMapUpload {
  version: string;
  files: SourceMapFile[];
}

export interface SourceMapFile {
  file_path: string;
  source_map: string;
}

// === B2B customer-scoped tracking ===

export interface EndUser {
  id: string;
  project_id: string;
  external_user_id: string;
  external_account_id?: string;
  email?: string;
  display_name?: string;
  first_seen: string;
  last_seen: string;
}

export interface AffectedUser {
  end_user_id: string;
  external_user_id: string;
  email?: string;
  external_account_id?: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
}

export interface Account {
  external_account_id: string;
  account_name?: string;
  user_count: number;
  incident_count: number;
  last_seen: string;
}

export type JobType = 'error_fix' | 'investigate' | 'fix' | 'session_analysis' | 'ci_watch' | 'route_map' | 'product_context' | 'issue_inquiry' | 'digest_write' | 'score_sync' | 'stack_resolve';

export type PRPosture = 'verified_only' | 'draft_when_unverified';

// === Session chunk wire format ===
// Keep wire-compatible with packages/sdk/src/telemetry.ts and
// packages/sdk/src/chunk-upload.ts. The SDK intentionally keeps local types to
// avoid taking a dependency on this package.

export type SessionTelemetryEvent =
  | { kind: 'click'; clickId: string; selector: string; cursor: string; at: number }
  | { kind: 'request_start'; requestId: string; clickId: string | null; method: string; url: string; at: number }
  | { kind: 'request_end'; requestId: string; status: number; at: number }
  | { kind: 'form_submit'; selector: string; at: number };

/**
 * Decompressed `session_chunks` object body. `events` are raw rrweb
 * `eventWithTime` entries; telemetry rides as rrweb custom events (top-level
 * `type === 5`, `data.tag === 'opslane.telemetry'`, and `data.payload` matches
 * {@link SessionTelemetryEvent}).
 */
export interface SessionChunkEnvelope {
  events: unknown[];
  meta: {
    sdk_version: string;
    has_full_snapshot: boolean;
    chunked_at: number;
  };
}

export type {
  Adjudication,
  CandidateDisposition,
  CauseLocation,
  Diagnosis,
  DiagnosisOutcome,
  EvidenceCitation,
  EvidenceStrength,
  GroundedQuote,
  HypothesisKind,
} from './diagnosis.js';
