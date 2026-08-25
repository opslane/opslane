// @vitest-environment node
// Captures the README product screenshots from the built dashboard with
// deterministic, mock-labelled demo data. Regenerate with:
//   pnpm --filter @opslane/dashboard build
//   CAPTURE_README_SCREENSHOTS=1 pnpm --filter @opslane/test-e2e exec vitest run readme-screenshots.test.ts
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDashboardBrowserAvailable,
  startDashboardMockHarness,
  type DashboardHarness,
  type DashboardMockFixture,
} from './dashboard-mock-harness.js';

const browserAvailable = await isDashboardBrowserAvailable();
const captureEnabled = process.env['CAPTURE_README_SCREENSHOTS'] === '1';
const outputDirectory = resolve(__dirname, '../docs/assets/readme');

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

const priorityInputs = (users7d: number, users24h: number, route: string | null) => ({
  users_7d: users7d,
  anon_sessions_7d: Math.round(users7d * 0.6),
  users_24h: users24h,
  anon_sessions_24h: Math.round(users24h * 0.5),
  impact: users7d,
  route_pattern: route,
  route_name: null,
  route_tier: route ? ('customer' as const) : null,
  route_weight: 1,
  cap_applied: false,
  reason_code: null,
});

const checkoutIncident = {
  id: 'incident-1',
  project_id: 'project-1',
  kind: 'error',
  platform: 'javascript',
  fingerprint: 'demo-fingerprint-1',
  title: "TypeError: Cannot read properties of undefined (reading 'total')",
  status: 'pr_created',
  first_seen: daysAgo(6),
  last_seen: minutesAgo(14),
  occurrence_count: 614,
  affected_users_count: 212,
  priority_score: 96,
  priority_inputs: priorityInputs(212, 57, '/checkout'),
  confidence: 'high',
  story:
    'Users with an expired coupon reach checkout, the totals endpoint returns 404, and the summary component crashes before the pay button renders.',
  root_cause:
    'CartSummary reads order.pricing.total before the pricing request resolves. When /api/orders/:id/pricing 404s on an expired coupon, `pricing` stays undefined and the render crashes, so the pay button never appears.',
  suggested_mitigation: 'Guard the summary render on pricing being present and surface the coupon error state.',
  pr_url: 'https://github.com/acme/storefront/pull/482',
  verification_evidence: {
    version: 2,
    tier: 'E2',
    checks: [
      { name: 'build', outcome: 'passed', command: 'pnpm build', exit_code: 0, output_tail: '✓ built in 8.3s' },
      {
        name: 'tests',
        outcome: 'passed',
        command: 'pnpm test -- checkout',
        exit_code: 0,
        output_tail: 'Test Files  14 passed (14)\n     Tests  86 passed (86)',
      },
      {
        name: 'review',
        outcome: 'passed',
        command: 'second-model diff review',
        exit_code: 0,
        output_tail: 'No regressions found; fix matches root cause.',
      },
    ],
    suite: { baseline_failed_tests: [], new_failures: [] },
  },
  environments: [{ id: 'env-production', name: 'production', occurrence_count: 614, last_seen: minutesAgo(14) }],
  recordings: [
    { session_id: 'session-demo-1', started_at: minutesAgo(16), duration_ms: 95_000, crash_count: 1, anchor_ms: now - 14 * 60_000 },
    { session_id: 'session-demo-2', started_at: minutesAgo(58), duration_ms: 132_000, crash_count: 2, anchor_ms: now - 55 * 60_000 },
  ],
};

const demoIncidents = [
  checkoutIncident,
  {
    id: 'incident-2',
    project_id: 'project-1',
    kind: 'friction',
    platform: 'javascript',
    signal_type: 'dead_click',
    adjudication_status: 'accepted',
    element_selector: 'button.apply-coupon',
    page_url_normalized: '/checkout',
    fingerprint: 'demo-fingerprint-2',
    title: 'Apply coupon button does nothing after a failed validation',
    status: 'fixing',
    first_seen: daysAgo(3),
    last_seen: minutesAgo(41),
    occurrence_count: 183,
    affected_users_count: 97,
    priority_score: 88,
    priority_inputs: priorityInputs(97, 31, '/checkout'),
    impact_class: 'blocked',
    story:
      'After a coupon fails validation once, the apply button stops responding. 97 users clicked it repeatedly this week with no console error.',
  },
  {
    id: 'incident-3',
    project_id: 'project-1',
    kind: 'error',
    platform: 'javascript',
    fingerprint: 'demo-fingerprint-3',
    title: "ChunkLoadError: Loading chunk 'settings' failed after deploy",
    status: 'needs_human',
    first_seen: daysAgo(1),
    last_seen: minutesAgo(53),
    occurrence_count: 74,
    affected_users_count: 38,
    priority_score: 71,
    priority_inputs: priorityInputs(38, 22, '/settings'),
    story: 'Sessions that stayed open across the Tuesday deploy request stale chunk hashes and fail to load settings.',
    reason: {
      reason_code: 'infrastructure_change_required',
      reason_message: 'The fix is a deploy configuration change (immutable asset caching), not an application code change.',
      remediation: 'Serve hashed assets with long-lived cache headers and keep previous-build chunks available during rollout.',
    },
  },
  {
    id: 'incident-4',
    project_id: 'project-1',
    kind: 'error',
    platform: 'javascript',
    fingerprint: 'demo-fingerprint-4',
    title: 'Unhandled promise rejection in InvoiceList: request aborted mid-pagination',
    status: 'analyzing',
    first_seen: minutesAgo(94),
    last_seen: minutesAgo(3),
    occurrence_count: 41,
    affected_users_count: 19,
    priority_score: 64,
    priority_inputs: priorityInputs(19, 19, '/invoices'),
    story: 'Fast page-through of invoices races the previous fetch; the abort surfaces as an unhandled rejection.',
  },
  {
    id: 'incident-5',
    project_id: 'project-1',
    kind: 'error',
    platform: 'javascript',
    fingerprint: 'demo-fingerprint-5',
    title: "TypeError: date.toLocaleDateString is not a function in ReportHeader",
    status: 'merged',
    first_seen: daysAgo(12),
    last_seen: daysAgo(4),
    occurrence_count: 388,
    affected_users_count: 141,
    priority_score: 52,
    priority_inputs: priorityInputs(141, 0, '/reports'),
    confidence: 'high',
    pr_url: 'https://github.com/acme/storefront/pull/431',
    merged_at: daysAgo(4),
    story: 'Report dates arrived as strings from the cache path; the fix normalises them at the API boundary.',
  },
  {
    id: 'incident-6',
    project_id: 'project-1',
    kind: 'error',
    platform: 'javascript',
    fingerprint: 'demo-fingerprint-6',
    title: 'ResizeObserver loop completed with undelivered notifications',
    status: 'new',
    first_seen: daysAgo(9),
    last_seen: minutesAgo(260),
    occurrence_count: 12,
    affected_users_count: 4,
    priority_score: 9,
    priority_inputs: priorityInputs(4, 1, null),
    state: 'watching',
    state_reason: 'Benign browser noise pattern; too few affected users to investigate.',
    state_decided_at: daysAgo(8),
    story: 'Known benign browser noise; watched in case volume changes.',
  },
  {
    id: 'incident-7',
    project_id: 'project-1',
    kind: 'error',
    platform: 'javascript',
    fingerprint: 'demo-fingerprint-7',
    title: 'NetworkError when attempting to fetch resource (extension injected)',
    status: 'new',
    first_seen: daysAgo(15),
    last_seen: minutesAgo(340),
    occurrence_count: 29,
    affected_users_count: 6,
    priority_score: 6,
    priority_inputs: priorityInputs(6, 2, null),
    state: 'watching',
    state_reason: 'Traffic originates from a password-manager extension, not product code.',
    state_decided_at: daysAgo(14),
    story: 'Requests are initiated by a browser extension, not product code.',
  },
];

const readmeFixture: DashboardMockFixture = {
  name: 'readme-capture-mock',
  authenticated: true,
  projectId: 'project-1',
  projectName: 'acme/storefront',
  responses: {
    'GET /api/v1/auth/me': {
      body: { id: 'user-1', org_id: 'org-1', email: 'demo@acme.dev', name: 'Demo Operator', is_admin: true, active_role: 'owner', memberships: [] },
    },
    'GET /api/v1/projects/project-1/sessions': {
      body: {
        sessions: [
          {
            id: '8f3a2c1b-4d6e-4a91-b0c7-2e5f1a9d3b84',
            started_at: minutesAgo(16),
            last_chunk_at: minutesAgo(14),
            status: 'analyzed',
            chunk_count: 4,
            playable_chunk_count: 4,
            error_count: 2,
            rage_click_count: 1,
            dead_click_count: 0,
            form_abandon_count: 0,
            bytes_stored: 48_120,
            page_url: 'https://store.acme.dev/checkout',
            sdk_release: '1.4.2',
            end_user: { id: 'end-user-1', external_user_id: 'user-2841', email: 'dana@northwindtrading.test', external_account_id: 'account-1', account_name: 'Northwind Trading' },
          },
          {
            id: 'sess_c47d90a1e6b25f38047ac1d9e83b6f52',
            started_at: minutesAgo(58),
            last_chunk_at: minutesAgo(55),
            status: 'analyzed',
            chunk_count: 3,
            playable_chunk_count: 3,
            error_count: 1,
            rage_click_count: 0,
            dead_click_count: 2,
            form_abandon_count: 0,
            bytes_stored: 31_744,
            page_url: 'https://store.acme.dev/checkout',
            sdk_release: '1.4.2',
            end_user: { id: 'end-user-2', external_user_id: 'user-1177', email: 'sam@bluesteelco.test', external_account_id: 'account-2', account_name: 'Blue Steel Co' },
          },
          {
            id: '2b1e6d90-77af-4f21-9c93-5f04dd6a11c2',
            started_at: minutesAgo(83),
            last_chunk_at: minutesAgo(80),
            status: 'analyzed',
            chunk_count: 2,
            playable_chunk_count: 2,
            error_count: 0,
            rage_click_count: 0,
            dead_click_count: 0,
            form_abandon_count: 1,
            bytes_stored: 18_402,
            page_url: 'https://store.acme.dev/invoices',
            sdk_release: '1.4.2',
            end_user: null,
          },
          {
            id: '61c0a4de-9b1f-4c55-a2c8-8a4f0f7f5e19',
            started_at: minutesAgo(129),
            last_chunk_at: minutesAgo(121),
            status: 'closed',
            chunk_count: 5,
            playable_chunk_count: 5,
            error_count: 0,
            rage_click_count: 0,
            dead_click_count: 0,
            form_abandon_count: 0,
            bytes_stored: 64_233,
            page_url: 'https://store.acme.dev/reports',
            sdk_release: '1.4.2',
            end_user: { id: 'end-user-3', external_user_id: 'user-3010', email: null, external_account_id: 'account-1', account_name: 'Northwind Trading' },
          },
        ],
        next_cursor: null,
        has_identified_sessions: true,
      },
    },
    'GET /api/v1/projects': {
      body: [{
        id: 'project-1',
        name: 'acme/storefront',
        github_repo: 'acme/storefront',
        friction_autonomy: 'ask_first',
        pr_posture: 'verified_only',
        default_environment_id: 'env-production',
        action_scope_enabled: false,
        action_environment_ids: [],
        digest_timezone: 'UTC',
        created_at: daysAgo(40),
      }],
    },
    'GET /api/v1/projects/project-1/incidents': { body: demoIncidents },
    'GET /api/v1/projects/project-1/incidents/incident-1': { body: checkoutIncident },
    'GET /api/v1/projects/project-1/incidents/incident-1/affected-users': {
      body: [
        { external_user_id: 'user-2841', email: 'dana@northwindtrading.test', last_seen: minutesAgo(14), occurrence_count: 9 },
        { external_user_id: 'user-1177', email: 'sam@bluesteelco.test', last_seen: minutesAgo(55), occurrence_count: 6 },
        { external_user_id: 'user-3010', email: null, last_seen: minutesAgo(78), occurrence_count: 4 },
      ],
    },
  },
};

describe.skipIf(!browserAvailable || !captureEnabled)('README screenshot capture', () => {
  let harness: DashboardHarness;

  beforeAll(async () => {
    mkdirSync(outputDirectory, { recursive: true });
    harness = await startDashboardMockHarness(readmeFixture);
    await harness.page.emulateMedia({ reducedMotion: 'reduce' });
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  });

  // The issues ledger gets a taller viewport so the hero shot ends after the
  // complete Watching section instead of cutting a row mid-height.
  const shots = [
    { path: '/', file: 'issues-list.png', identity: /^Issues$/i, height: 1100 },
    { path: '/issues/incident-1', file: 'issue-detail.png', identity: /reading 'total'/i, height: 900 },
    { path: '/sessions', file: 'sessions-list.png', identity: /^Recorded sessions$/i, height: 900 },
  ];

  for (const shot of shots) {
    it(`captures ${shot.file}`, async () => {
      await harness.page.setViewportSize({ width: 1440, height: shot.height });
      await harness.page.goto(`${harness.url}${shot.path}`);
      await expect.poll(async () => harness.page.getByText(shot.identity).count()).toBeGreaterThan(0);
      await harness.page.evaluate(async () => { await document.fonts.ready; });
      await harness.page.screenshot({
        path: resolve(outputDirectory, shot.file),
        fullPage: false,
        animations: 'disabled',
      });
      harness.assertClean();
    });
  }
});
