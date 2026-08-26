import type {
  Incident, AffectedUser, Account, IncidentFilters,
  SampleEvent,
  GitHubConfig, GitHubAppStatus, GitHubRepo,
  SessionDetail, SessionFilters, SessionListResponse,
  AdminOverview, AdminJobsResponse, HealthResponse,
  AuthConfig, AuthUser, ForgotPasswordResult, OrgInvitation,
	NotificationDestination, NotificationDestinationList, NotificationEventType, NotificationTestResult,
  OAuthEmailVerificationResult, PasswordAuthResult, ResetPasswordResult,
	ManagedAPIKey, CreatedAPIKey, OnboardingState,
} from './types/api';
export type {
  AuthConfig, AuthMembership, AuthUser, ForgotPasswordResult, OrgInvitation,
  OAuthEmailVerificationResult, PasswordAuthResult, ResetPasswordResult,
  ManagedAPIKey, CreatedAPIKey,
} from './types/api';
import type { ChunkEnvelope } from './components/session-replay';

const BASE = '/api/v1';

// === Auth state ===
//
// Tokens live only in httpOnly cookies set by the backend. JS keeps a non-secret
// hint so the synchronous router guard can decide "probably authenticated"; the
// cookie remains the server-enforced source of truth.

const AUTHED_KEY = 'opslane_authed';

// One-time cleanup of pre-cookie token storage. These are the historical key
// names an older build actually wrote — do not rename them.
localStorage.removeItem('defender_access_token');
localStorage.removeItem('defender_refresh_token');
localStorage.removeItem('defender_token_expires_at');

export function isAuthenticated(): boolean {
  return !!localStorage.getItem(AUTHED_KEY);
}

export function markAuthed(): void {
  localStorage.setItem(AUTHED_KEY, '1');
}

export function clearAuth(): void {
	localStorage.removeItem(AUTHED_KEY);
	localStorage.removeItem('opslane_onboarding_complete');
  // Historical pre-cookie key names — do not rename.
  localStorage.removeItem('defender_access_token');
  localStorage.removeItem('defender_refresh_token');
  localStorage.removeItem('defender_token_expires_at');
}


// Deduplicates concurrent refresh calls so only one hits the backend.
// Without this, parallel fetchWithAuth calls near token expiry would each
// consume the single-use refresh token, causing spurious logouts.
let inflightRefresh: Promise<boolean> | null = null;

function refreshTokens(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh().finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });

    if (!res.ok) {
      clearAuth();
      return false;
    }

    markAuthed();
    return true;
  } catch {
    clearAuth();
    return false;
  }
}

// === Shared auth-aware fetch core ===

export class APIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'APIError';
  }
}

async function fetchWithAuth<T>(path: string, options: RequestInit = {}): Promise<T> {
  const doFetch = (): Promise<Response> =>
    fetch(`${BASE}${path}`, { ...options, credentials: 'include' });

  let res = await doFetch();

  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      res = await doFetch();
    } else {
      clearAuth();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new APIError(res.status, `API ${res.status}: ${body || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// === HTTP helpers ===

export function fetchJSON<T>(path: string): Promise<T> {
  return fetchWithAuth<T>(path);
}

export function postJSON<T>(path: string, body: unknown): Promise<T> {
  return fetchWithAuth<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function patchJSON<T>(path: string, body: unknown): Promise<T> {
  return fetchWithAuth<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function deleteJSON<T>(path: string): Promise<T> {
  return fetchWithAuth<T>(path, { method: 'DELETE' });
}

// === Types ===

export interface Project {
  id: string;
  name: string;
  github_repo: string | null;
  friction_autonomy: 'ask_first' | 'auto_fix' | 'auto_fix_ux';
  pr_posture: 'verified_only' | 'draft_when_unverified';
  default_environment_id: string | null;
  action_scope_enabled: boolean;
  action_environment_ids: string[];
  digest_timezone: string;
  created_at: string;
}

export interface FixStats {
  generated_auto: number;
  generated_human: number;
  prs_merged: number;
  prs_closed: number;
  /** Outcomes attributed to auto-triggered fix jobs only. */
  prs_merged_auto: number;
  prs_closed_auto: number;
}

export interface Environment {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
}

export interface EnvironmentListResponse {
  environments: Environment[];
  rollup_ready: boolean;
}

export interface APIKeyCreated {
  id: string;
  raw_key: string;
  created_at?: string;
}

export interface ProjectProvisioningResponse {
  project: Project;
  environment: Environment;
  api_key: APIKeyCreated;
}

export interface OnboardingSetupResponse {
  project: Project;
  environment: Environment;
  api_key: APIKeyCreated;
}

export interface EventStatus {
	has_events: boolean;
	latest_error_group_id: string | null;
}

// === Project D: replay ===
export interface ReplayRecording {
  events: unknown[];
  meta?: {
    sdk_version?: string;
    page_url?: string;
    started_at?: string;
    ended_at?: string;
    crash_timestamp?: number;
  };
}

// === API functions ===

export function getMe(): Promise<AuthUser> {
  return fetchJSON<AuthUser>('/auth/me');
}

const AUTH_NETWORK_ERROR = 'Unable to reach the server. Please try again.';

type AuthErrorResult = { status: 'error'; code: number; message: string };

function authErrorResult(code: number, data: unknown): AuthErrorResult {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  return {
    status: 'error',
    code,
    message: typeof record.error === 'string' ? record.error : 'Something went wrong',
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  const response = await fetch('/auth/config', { credentials: 'include' });
  const data = await readResponseBody(response);
  if (!response.ok) {
    const result = authErrorResult(response.status, data);
    throw new APIError(result.code, result.message);
  }
  return data as AuthConfig;
}

async function postAuthFlow(path: string, body: unknown): Promise<PasswordAuthResult> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await readResponseBody(response);
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};

    if (response.ok) {
      return { status: 'authenticated', user: record.user as AuthUser };
    }
    if (response.status === 403 && record.status === 'email_verification_required') {
      return {
        status: 'email_verification_required',
        pending_authentication_token: String(record.pending_authentication_token ?? ''),
      };
    }
    return authErrorResult(response.status, data);
  } catch {
    return { status: 'error', code: 0, message: AUTH_NETWORK_ERROR };
  }
}

export function passwordLogin(email: string, password: string): Promise<PasswordAuthResult> {
  return postAuthFlow('/auth/password', { email, password });
}

export function signup(email: string, password: string): Promise<PasswordAuthResult> {
  return postAuthFlow('/auth/signup', { email, password });
}

export function verifyEmail(pendingToken: string, code: string): Promise<PasswordAuthResult> {
  return postAuthFlow('/auth/verify-email', {
    pending_authentication_token: pendingToken,
    code,
  });
}

export async function verifyOAuthEmail(code: string): Promise<OAuthEmailVerificationResult> {
  try {
    const response = await fetch('/auth/oauth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code }),
    });
    const data = await readResponseBody(response);
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};

    if (response.ok && typeof record.redirect_to === 'string' && record.redirect_to) {
      return { status: 'verified', redirect_to: record.redirect_to };
    }
    if (!response.ok) return authErrorResult(response.status, data);
    return { status: 'error', code: response.status, message: 'Something went wrong' };
  } catch {
    return { status: 'error', code: 0, message: AUTH_NETWORK_ERROR };
  }
}

export async function forgotPassword(email: string): Promise<ForgotPasswordResult> {
  try {
    const response = await fetch('/auth/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email }),
    });
    if (response.ok) return { status: 'sent' };
    const data = await readResponseBody(response);
    const result = authErrorResult(response.status, data);
    return result;
  } catch {
    return { status: 'error', code: 0, message: AUTH_NETWORK_ERROR };
  }
}

export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<ResetPasswordResult> {
  try {
    const response = await fetch('/auth/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token, new_password: newPassword }),
    });
    if (response.ok) {
      clearAuth();
      return { status: 'reset' };
    }
    const data = await readResponseBody(response);
    const result = authErrorResult(response.status, data);
    return result;
  } catch {
    return { status: 'error', code: 0, message: AUTH_NETWORK_ERROR };
  }
}

export async function switchOrg(orgID: string): Promise<void> {
  const response = await fetch('/auth/switch-org', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgID }),
  });
  if (!response.ok) {
    throw new APIError(response.status, `Unable to switch organization (${response.status})`);
  }
  localStorage.removeItem('opslane_project_id');
  localStorage.removeItem('opslane_project_name');
}

export function listInvitations(): Promise<OrgInvitation[]> {
  return fetchJSON<OrgInvitation[]>('/invitations');
}

export function createInvitation(email: string, role: OrgInvitation['role']): Promise<{ invitation: OrgInvitation; token: string }> {
  return postJSON<{ invitation: OrgInvitation; token: string }>('/invitations', { email, role });
}

export function revokeInvitation(invitationID: string): Promise<{ ok: boolean }> {
  return deleteJSON<{ ok: boolean }>(`/invitations/${invitationID}`);
}

export function acceptInvitation(token: string): Promise<{ ok: boolean; org_id: string }> {
  return postJSON<{ ok: boolean; org_id: string }>('/invitations/accept', { token });
}

// A hung admin request would otherwise wedge AdminView's poll loop forever
// (its refreshing guard skips every later tick), so these calls carry a timeout.
const ADMIN_FETCH_TIMEOUT_MS = 30_000;

export function getAdminOverview(): Promise<AdminOverview> {
  return fetchWithAuth<AdminOverview>('/admin/overview', {
    signal: AbortSignal.timeout(ADMIN_FETCH_TIMEOUT_MS),
  });
}

export function listAdminJobs(limit = 50): Promise<AdminJobsResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchWithAuth<AdminJobsResponse>(`/admin/jobs?${params}`, {
    signal: AbortSignal.timeout(ADMIN_FETCH_TIMEOUT_MS),
  });
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch('/health', {
    credentials: 'include',
    signal: AbortSignal.timeout(ADMIN_FETCH_TIMEOUT_MS),
  });
  // The health endpoint intentionally returns its useful diagnostic payload with
  // a 503 when the database is unhealthy, so callers should still render it.
  if (!response.ok && response.status !== 503) {
    throw new APIError(response.status, `Health API ${response.status}`);
  }
  try {
    return await response.json() as HealthResponse;
  } catch {
    throw new APIError(response.status, `Health API ${response.status}: non-JSON response`);
  }
}

export function listProjects(): Promise<Project[]> {
  return fetchJSON<Project[]>('/projects');
}

export function createProject(
  name: string,
  githubRepo: string,
  idempotencyToken: string,
): Promise<ProjectProvisioningResponse> {
  return postJSON<ProjectProvisioningResponse>('/projects', {
    name,
    github_repo: githubRepo || undefined,
    idempotency_token: idempotencyToken,
  });
}

export function updateProject(
  projectId: string,
  data: {
    github_repo?: string;
    friction_autonomy?: Project['friction_autonomy'];
    pr_posture?: Project['pr_posture'];
    default_environment_id?: string;
    action_environment_ids?: string[] | null;
    digest_timezone?: string;
  }
): Promise<Project> {
  return patchJSON<Project>(`/projects/${projectId}`, data);
}

export function getFixStats(projectId: string): Promise<Record<'error' | 'friction', FixStats>> {
  return fetchJSON<Record<'error' | 'friction', FixStats>>(`/projects/${projectId}/fix-stats`);
}

export function listEnvironments(
  projectId: string,
  usedBy?: 'incidents' | 'sessions',
): Promise<EnvironmentListResponse> {
  const query = usedBy ? `?used_by=${usedBy}` : '';
  return fetchJSON<EnvironmentListResponse>(`/projects/${projectId}/environments${query}`);
}

export function listAPIKeys(projectId: string): Promise<ManagedAPIKey[]> {
  return fetchJSON<ManagedAPIKey[]>(`/projects/${projectId}/api-keys`);
}

export function createAPIKey(
	projectId: string,
	input: { label: string; expires_at: string | null; scope?: 'api' | 'ingest' },
): Promise<CreatedAPIKey> {
  return postJSON<CreatedAPIKey>(`/projects/${projectId}/api-keys`, input);
}

export function revokeAPIKey(projectId: string, keyId: string): Promise<void> {
  return fetchWithAuth<void>(`/projects/${projectId}/api-keys/${keyId}`, { method: 'DELETE' });
}

export function listNotificationDestinations(
  projectId: string,
): Promise<NotificationDestinationList> {
  return fetchJSON<NotificationDestinationList>(
    `/projects/${projectId}/notification-destinations`,
  );
}

export function createNotificationDestination(
	projectId: string,
	data: {
		name: string;
		webhook_url: string;
		enabled?: boolean;
		event_types?: NotificationEventType[];
		delivery_policy?: NotificationDestination['delivery_policy'];
	},
): Promise<NotificationDestination> {
  return postJSON<NotificationDestination>(
    `/projects/${projectId}/notification-destinations`,
    data,
  );
}

export function updateNotificationDestination(
  projectId: string,
  destinationId: string,
  patch: {
    name?: string;
    webhook_url?: string;
    enabled?: boolean;
    event_types?: NotificationDestination['event_types'];
    delivery_policy?: NotificationDestination['delivery_policy'];
  },
): Promise<NotificationDestination> {
  return patchJSON<NotificationDestination>(
    `/projects/${projectId}/notification-destinations/${destinationId}`,
    patch,
  );
}

export function deleteNotificationDestination(
  projectId: string,
  destinationId: string,
): Promise<{ ok: boolean }> {
  return deleteJSON<{ ok: boolean }>(
    `/projects/${projectId}/notification-destinations/${destinationId}`,
  );
}

export function testNotificationDestination(
  projectId: string,
  destinationId: string,
  opts?: { eventType?: NotificationDestination['event_types'][number] },
): Promise<NotificationTestResult> {
  return postJSON<NotificationTestResult>(
    `/projects/${projectId}/notification-destinations/${destinationId}/test`,
    opts?.eventType ? { event_type: opts.eventType } : {},
  );
}

export function onboardingSetup(
	projectName: string,
	idempotencyToken: string,
): Promise<OnboardingSetupResponse> {
	return postJSON<OnboardingSetupResponse>('/onboarding/setup', {
		project_name: projectName,
		idempotency_token: idempotencyToken,
	});
}

export function getOnboardingState(): Promise<OnboardingState> {
	return fetchJSON<OnboardingState>('/onboarding/state');
}

export function completeOnboarding(): Promise<{ onboarding_complete: boolean }> {
	return postJSON<{ onboarding_complete: boolean }>('/onboarding/complete', {});
}

export function getEventStatus(projectId: string): Promise<EventStatus> {
  return fetchJSON<EventStatus>(`/projects/${projectId}/event-count`);
}

export function getGitHubConfig(projectId: string): Promise<GitHubConfig> {
  return fetchJSON<GitHubConfig>(`/projects/${projectId}/github`);
}

export function setGitHubConfig(
  projectId: string,
  data: { github_repo: string }
): Promise<GitHubConfig> {
  return fetchWithAuth<GitHubConfig>(`/projects/${projectId}/github`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function deleteGitHubConfig(projectId: string): Promise<{ ok: boolean }> {
  return deleteJSON<{ ok: boolean }>(`/projects/${projectId}/github`);
}

// === GitHub App ===

export function getGitHubAppStatus(): Promise<GitHubAppStatus> {
  return fetchJSON<GitHubAppStatus>('/github/status');
}

export function listGitHubRepos(): Promise<GitHubRepo[]> {
  return fetchJSON<GitHubRepo[]>('/github/repos');
}

export function listIncidents(
  projectId: string,
  filters?: IncidentFilters
): Promise<Incident[]> {
  const params = new URLSearchParams();
  if (filters?.account_id) params.set('account_id', filters.account_id);
  if (filters?.end_user_id) params.set('end_user_id', filters.end_user_id);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.platform) params.set('platform', filters.platform);
  if (filters?.environment_id) params.set('environment_id', filters.environment_id);
  const qs = params.toString();
  return fetchJSON<Incident[]>(
    `/projects/${projectId}/incidents${qs ? `?${qs}` : ''}`
  );
}

export function getIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return fetchJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}`
  );
}

export function requestIssueReview(
  projectId: string,
  incidentId: string,
): Promise<{ job_id: string }> {
  return postJSON<{ job_id: string }>(
    `/projects/${projectId}/incidents/${incidentId}/review`,
    {},
  );
}

export function getSampleEvent(
  projectId: string,
  incidentId: string
): Promise<SampleEvent> {
  return fetchJSON<SampleEvent>(
    `/projects/${projectId}/incidents/${incidentId}/sample-event`
  );
}

export function getReplay(projectId: string, replayId: string): Promise<ReplayRecording> {
  return fetchJSON<ReplayRecording>(`/projects/${projectId}/replays/${replayId}`);
}

export function listSessions(
  projectId: string,
  filters?: SessionFilters,
  cursor?: string,
): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  if (filters?.search) params.set('search', filters.search);
  if (filters?.has_signals) params.set('has_signals', 'true');
  if (filters?.environment_id) params.set('environment_id', filters.environment_id);
  if (filters?.from) params.set('from', filters.from);
  if (filters?.to) params.set('to', filters.to);
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return fetchJSON<SessionListResponse>(
    `/projects/${projectId}/sessions${qs ? `?${qs}` : ''}`,
  );
}

export function getSession(projectId: string, sessionId: string): Promise<SessionDetail> {
  return fetchJSON<SessionDetail>(`/projects/${projectId}/sessions/${sessionId}`);
}

export function getSessionChunk(
  projectId: string,
  sessionId: string,
  seq: number,
): Promise<ChunkEnvelope> {
  return fetchJSON<ChunkEnvelope>(
    `/projects/${projectId}/sessions/${sessionId}/chunks/${seq}`,
  );
}

export function listAffectedUsers(
  projectId: string,
  incidentId: string
): Promise<AffectedUser[]> {
  return fetchJSON<AffectedUser[]>(
    `/projects/${projectId}/incidents/${incidentId}/affected-users`
  );
}

export function triggerFix(
  projectId: string,
  incidentId: string,
  guidance?: string
): Promise<{ job_id: string }> {
  return postJSON<{ job_id: string }>(
    `/projects/${projectId}/incidents/${incidentId}/fix`,
    guidance ? { guidance } : {}
  );
}

export function listAccounts(
  projectId: string,
  query?: string
): Promise<Account[]> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const qs = params.toString();
  return fetchJSON<Account[]>(
    `/projects/${projectId}/accounts${qs ? `?${qs}` : ''}`
  );
}

export function getAccount(
  projectId: string,
  accountId: string
): Promise<Account> {
  return fetchJSON<Account>(
    `/projects/${projectId}/accounts/${accountId}`
  );
}

export function listAccountIncidents(
  projectId: string,
  accountId: string
): Promise<Incident[]> {
  return fetchJSON<Incident[]>(
    `/projects/${projectId}/accounts/${accountId}/incidents`
  );
}

// === Incident lifecycle actions ===

export function resolveIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return postJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}/resolve`,
    {}
  );
}

export function archiveIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return postJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}/archive`,
    {}
  );
}

export function unarchiveIncident(
  projectId: string,
  incidentId: string
): Promise<Incident> {
  return postJSON<Incident>(
    `/projects/${projectId}/incidents/${incidentId}/unarchive`,
    {}
  );
}
