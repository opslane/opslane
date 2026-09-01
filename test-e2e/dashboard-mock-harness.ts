import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page, Request, Route } from '@playwright/test';
import type { PreviewServer } from 'vite';

const REPO_ROOT = resolve(__dirname, '..');
const DASHBOARD_ROOT = resolve(REPO_ROOT, 'packages/dashboard');
const MANIFEST_PATH = resolve(REPO_ROOT, 'docs/design/dashboard-v1/request-manifest.json');

interface ManifestRequest {
  method: string;
  path: string;
}

interface RequestManifest {
  requests: ManifestRequest[];
}

export interface DashboardMockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  delayMs?: number;
}

export interface DashboardMockFixture {
  name: `${string}-mock`;
  authenticated?: boolean;
  projectId?: string;
  projectName?: string;
  responses?: Record<string, DashboardMockResponse>;
}

export interface DashboardHarness {
  url: string;
  page: Page;
  context: BrowserContext;
  requests: string[];
  pageErrors: string[];
  consoleErrors: string[];
  failedResources: string[];
  unexpectedRequests: string[];
  assertClean(): void;
  close(): Promise<void>;
}

export const dashboardMockFixtures = {
  success: {
    name: 'dashboard-success-mock',
    authenticated: true,
    projectId: 'project-1',
    projectName: 'Acme (mock)',
  },
  empty: {
    name: 'dashboard-empty-mock',
    authenticated: true,
    projectId: 'project-1',
    projectName: 'Acme (mock)',
    responses: {
      'GET /api/v1/projects/project-1/incidents': { body: [] },
      'GET /api/v1/projects/project-1/accounts': { body: [] },
      'GET /api/v1/projects/project-1/sessions': {
        body: { sessions: [], next_cursor: null, has_identified_sessions: false },
      },
    },
  },
  // The incident list fails while everything else succeeds, so the ledger's
  // error branch renders inside a normally-shelled page.
  incidentsError: {
    name: 'dashboard-incidents-error-mock',
    authenticated: true,
    projectId: 'project-1',
    projectName: 'Acme (mock)',
    responses: {
      'GET /api/v1/projects/project-1/incidents': {
        status: 500,
        body: { error: 'Mock upstream failure' },
      },
    },
  },
  signedOut: {
    name: 'dashboard-signed-out-mock',
    authenticated: false,
  },
} satisfies Record<string, DashboardMockFixture>;

function manifest(): RequestManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as RequestManifest;
}

function templateRegex(template: string): RegExp {
  const escaped = template
    .split('/')
    .map((segment) => /^\{[^}]+\}$/.test(segment)
      ? '[^/]+'
      : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

function isNetworkSink(pathname: string): boolean {
  return pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/auth/');
}

function defaultBody(method: string, pathname: string): unknown {
  if (pathname === '/auth/config') {
    return { provider: 'embedded', supports_password: true, supports_signup: true, supports_reset: true, social_providers: [] };
  }
  if (pathname === '/api/v1/auth/me') {
    // onboarding_complete stays false so the /setup smoke renders the wizard
    // instead of bouncing to the dashboard; the seeded localStorage flag keeps
    // the router guard open for every other route.
    return { id: 'user-1', org_id: 'org-1', email: 'mock@example.test', name: 'Mock Operator', is_admin: true, active_role: 'owner', memberships: [], onboarding_complete: false };
  }
  if (pathname === '/api/v1/projects') {
    return [{ id: 'project-1', name: 'Acme (mock)', github_repo: 'example/mock', friction_autonomy: 'ask_first', pr_posture: 'verified_only', default_environment_id: 'env-production', action_scope_enabled: false, action_environment_ids: [], digest_timezone: 'UTC', created_at: '2026-01-01T00:00:00Z' }];
  }
  if (/\/incidents$/.test(pathname) && method === 'GET') return [mockIncident()];
  if (/\/incidents\/[^/]+$/.test(pathname) && method === 'GET') return mockIncident();
  if (/\/sample-event$/.test(pathname)) {
    return { timestamp: '2026-01-01T00:00:00Z', platform: 'javascript', error: { type: 'TypeError', message: 'Mock failure', stack: 'TypeError: Mock failure\n    at mock.ts:1:1' }, breadcrumbs: [], context: {} };
  }
  if (/\/affected-users$/.test(pathname)) return [];
  if (/\/accounts$/.test(pathname) && method === 'GET') return [mockAccount()];
  if (/\/accounts\/[^/]+\/incidents$/.test(pathname)) return [mockIncident()];
  if (/\/accounts\/[^/]+$/.test(pathname)) return mockAccount();
  if (/\/sessions$/.test(pathname)) {
    return { sessions: mockSessions(), next_cursor: null, has_identified_sessions: true };
  }
  if (/\/sessions\/[^/]+\/chunks\/[0-9]+$/.test(pathname)) return { events: [] };
  if (/\/sessions\/[^/]+\/narrative$/.test(pathname)) return mockNarrative();
  if (/\/sessions\/[^/]+$/.test(pathname)) return { ...mockSession(), chunks: [] };
  if (/\/replays\/[^/]+$/.test(pathname)) return { events: [], meta: {} };
  if (pathname === '/api/v1/admin/overview') return mockAdminOverview();
  if (pathname === '/api/v1/admin/jobs') return { jobs: [] };
  if (pathname === '/health') return { status: 'ok', checks: {}, version: 'mock', uptime_seconds: 1 };
  if (pathname === '/api/v1/onboarding/state') {
    return { onboarding_complete: false, next_step: 'connect_github', project_id: 'project-1', has_events: true, github_connected: false, github_mode: 'app', slack_connected: false };
  }
  if (pathname === '/api/v1/onboarding/complete' && method === 'POST') return { onboarding_complete: true };
  if (pathname === '/api/v1/github/status') return { installed: true, installation_id: 1, install_url: 'https://github.com/apps/example' };
  if (pathname === '/api/v1/github/repos') return [];
  if (/\/fix-stats$/.test(pathname)) {
    const stats = { generated_auto: 0, generated_human: 0, prs_merged: 0, prs_closed: 0, prs_merged_auto: 0, prs_closed_auto: 0 };
    return { error: stats, friction: stats };
  }
  if (/\/environments$/.test(pathname) && method === 'GET') return { environments: [], rollup_ready: true };
  if (/\/api-keys$/.test(pathname) && method === 'GET') return [];
  if (/\/notification-destinations$/.test(pathname) && method === 'GET') return { can_manage: true, destinations: [] };
  if (/\/github$/.test(pathname) && method === 'GET') return { github_repo: 'example/mock', connected: true };
  if (/\/event-count$/.test(pathname)) return { has_events: false };
  if (/\/setup-pr$/.test(pathname) && method === 'GET') return { status: 'open', pr_url: 'https://github.com/example/mock/pull/1', pr_number: 1 };
  if (pathname === '/api/v1/invitations' && method === 'GET') return [];
  if (method === 'DELETE') return { ok: true };
  return { ok: true };
}

function mockIncident(): Record<string, unknown> {
  return {
    id: 'incident-1', project_id: 'project-1', kind: 'error', platform: 'javascript', fingerprint: 'mock-fingerprint',
    title: 'Mock incident title', status: 'pr_created', first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-01T00:05:00Z',
    occurrence_count: 3, affected_users_count: 1, confidence: 'high', root_cause: 'Mock-only root cause',
    suggested_mitigation: 'Mock-only mitigation', pr_url: 'https://github.com/example/mock/pull/1', environments: [],
  };
}

function mockNarrative(): Record<string, unknown> {
  return {
    userGoal: 'Complete checkout with a saved card',
    narrative: 'The user reached payment, retried the pay button three times with no visible response, and abandoned the flow.',
    observations: [
      {
        id: 'obs-1',
        category: 'no_feedback_after_action',
        what: 'Clicking Pay produced no visible response.',
        severity: 'high',
        evidenceLines: ['L12', 'L13'],
        grade: 'confirmed',
        atMs: 41_000,
      },
    ],
    notable: true,
  };
}

function mockAccount(): Record<string, unknown> {
  return { external_account_id: 'account-1', account_name: 'Mock Account', user_count: 1, incident_count: 1, last_seen: '2026-01-01T00:05:00Z' };
}

function mockSession(): Record<string, unknown> {
  return mockSessions()[0]!;
}

function mockSessions(): Array<Record<string, unknown>> {
  const base = {
    bytes_stored: 2_048,
    page_url: 'https://example.test/checkout?step=payment',
    sdk_release: '1.4.2',
  };
  return [
    {
      ...base,
      id: 'session-1',
      started_at: '2026-07-22T20:02:00Z',
      last_chunk_at: '2026-07-22T20:09:21Z',
      status: 'analyzed',
      chunk_count: 2,
      playable_chunk_count: 2,
      error_count: 3,
      rage_click_count: 2,
      dead_click_count: 0,
      form_abandon_count: 0,
      end_user: {
        id: 'end-user-1',
        external_user_id: 'user-123',
        email: 'jane@acme.com',
        external_account_id: 'account-1',
        account_name: 'Acme Corp',
      },
    },
    {
      ...base,
      // Real shape, not a descriptive slug: the SDK emits either
      // crypto.randomUUID() or `sess_`+32 hex (sdk/src/session.ts:37-46). A
      // descriptive id makes the row's short-id rendering unrepresentative of
      // what any user sees, and two slugs sharing a prefix collide on screen.
      id: '8f3a2c1b-4d6e-4a91-b0c7-2e5f1a9d3b84',
      started_at: '2026-07-22T19:31:00Z',
      last_chunk_at: '2026-07-22T19:33:48Z',
      status: 'analyzed',
      chunk_count: 1,
      playable_chunk_count: 1,
      error_count: 0,
      rage_click_count: 0,
      dead_click_count: 0,
      form_abandon_count: 0,
      end_user: null,
    },
    {
      ...base,
      id: 'session-queued',
      started_at: '2026-07-22T19:18:00Z',
      last_chunk_at: '2026-07-22T19:19:05Z',
      status: 'closed',
      chunk_count: 1,
      playable_chunk_count: 1,
      error_count: 0,
      rage_click_count: 0,
      dead_click_count: 0,
      form_abandon_count: 0,
      end_user: {
        id: 'end-user-2',
        external_user_id: 'user-queued',
        email: null,
        external_account_id: 'account-1',
        account_name: 'Acme Corp',
      },
    },
    {
      ...base,
      // The `sess_`+hex fallback the SDK uses outside a secure context.
      id: 'sess_c47d90a1e6b25f38047ac1d9e83b6f52',
      started_at: '2026-07-22T18:59:00Z',
      last_chunk_at: null,
      status: 'analysis_failed',
      chunk_count: 2,
      playable_chunk_count: 0,
      error_count: 1,
      rage_click_count: 0,
      dead_click_count: 1,
      form_abandon_count: 0,
      end_user: null,
    },
  ];
}

function mockAdminOverview(): Record<string, unknown> {
  return {
    events: { last_1h: 0, last_24h: 0, last_7d: 0, hourly: [], top_projects: [] },
    jobs: { by_status: {}, by_type: {}, oldest_pending_age_seconds: null, dead_letters_7d: 0 },
    workers: { live_claims: 0, active_5m: 0 },
    outcomes: { by_status: {}, pr_created_24h: 0, pr_created_7d: 0, needs_human_7d: 0, merged_7d: 0, closed_7d: 0, spend_usd_7d: 0, cost_per_merged_pr_7d: null },
  };
}

async function closePreview(server: PreviewServer): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.httpServer.close((error) => error ? reject(error) : resolveClose());
  });
}

export async function isDashboardBrowserAvailable(): Promise<boolean> {
  if (!existsSync(resolve(DASHBOARD_ROOT, 'dist/index.html'))) return false;
  try {
    const { chromium } = await import('@playwright/test');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

export interface DashboardHarnessOptions {
  /**
   * Record a WebM of the session to this directory. Playwright only flushes the
   * file on context close, which `close()` already does before the browser, so
   * callers get a complete video. Off by default: recording is demo/evidence
   * tooling, not something the capture or smoke suites should pay for.
   */
  recordVideoDir?: string;
  viewport?: { width: number; height: number };
}

export async function startDashboardMockHarness(
  fixture: DashboardMockFixture = dashboardMockFixtures.success,
  options: DashboardHarnessOptions = {},
): Promise<DashboardHarness> {
  if (!fixture.name.endsWith('-mock')) throw new Error('Dashboard fixtures must be explicitly mock-labelled');
  if (!existsSync(resolve(DASHBOARD_ROOT, 'dist/index.html'))) {
    throw new Error('Dashboard dist is missing; run pnpm --filter @opslane/dashboard build first');
  }

  const { preview } = await import('vite');
  const server = await preview({
    root: DASHBOARD_ROOT,
    configFile: resolve(DASHBOARD_ROOT, 'vite.config.ts'),
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  const address = server.httpServer.address() as AddressInfo | null;
  if (!address) throw new Error('Vite preview did not expose an address');
  const url = `http://127.0.0.1:${address.port}`;

  const { chromium } = await import('@playwright/test');
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const viewport = options.viewport ?? { width: 1440, height: 1000 };
    const context = await browser.newContext({
      viewport,
      ...(options.recordVideoDir ? { recordVideo: { dir: options.recordVideoDir, size: viewport } } : {}),
    });
    await context.addInitScript((seed) => {
      localStorage.clear();
      sessionStorage.clear();
      if (seed.authenticated) {
        localStorage.setItem('opslane_authed', '1');
        // The router's onboarding guard treats this cached flag as session
        // state; a planted authed session without it bounces every page to
        // /setup (the wizard itself re-checks the server).
        localStorage.setItem('opslane_onboarding_complete', '1');
      }
      if (seed.projectId) localStorage.setItem('opslane_project_id', seed.projectId);
      if (seed.projectName) localStorage.setItem('opslane_project_name', seed.projectName);
    }, fixture);

    const requestManifest = manifest();
    const matchers = requestManifest.requests.map((entry) => ({ ...entry, regex: templateRegex(entry.path) }));
    const requests: string[] = [];
    const unexpectedRequests: string[] = [];
    const failedResources: string[] = [];
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    await context.route('**/*', async (route: Route) => {
      const request = route.request();
      const parsed = new URL(request.url());
      const sameOrigin = parsed.origin === url;
      if (!sameOrigin) {
        unexpectedRequests.push(`${request.method()} ${request.url()}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (request.isNavigationRequest()) {
        await route.continue();
        return;
      }
      if (!isNetworkSink(parsed.pathname)) {
        await route.continue();
        return;
      }

      const key = `${request.method()} ${parsed.pathname}`;
      requests.push(key);
      const matched = matchers.some((entry) => entry.method === request.method() && entry.regex.test(parsed.pathname));
      if (!matched) {
        unexpectedRequests.push(key);
        await route.abort('blockedbyclient');
        return;
      }

      const response = fixture.responses?.[key] ?? { body: defaultBody(request.method(), parsed.pathname) };
      if (response.delayMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, response.delayMs));
      await route.fulfill({
        status: response.status ?? 200,
        headers: { 'content-type': 'application/json', ...response.headers },
        body: JSON.stringify(response.body ?? defaultBody(request.method(), parsed.pathname)),
      });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', (request: Request) => failedResources.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`));

    return {
      url, page, context, requests, pageErrors, consoleErrors, failedResources, unexpectedRequests,
      assertClean() {
        if (unexpectedRequests.length || pageErrors.length || consoleErrors.length || failedResources.length) {
          throw new Error(JSON.stringify({ unexpectedRequests, pageErrors, consoleErrors, failedResources }, null, 2));
        }
      },
      async close() {
        await context.close();
        await browser?.close();
        await closePreview(server);
      },
    };
  } catch (error) {
    await browser?.close();
    await closePreview(server);
    throw error;
  }
}
