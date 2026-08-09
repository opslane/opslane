<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { APIError, getAdminOverview, getHealth, listAdminJobs } from '../api';
import { adminStatusBadgeClass, formatDuration, onboardingFunnelStages } from '../admin-format';
import AdminHourlyChart from '../components/AdminHourlyChart.vue';
import type { AdminJob, AdminJobStatus, AdminOverview, ErrorGroupStatus, HealthResponse } from '../types/api';
import { formatDate, GITHUB_PR_URL_OPTIONS, safeUrl } from '../utils';
import Button from '../components/ui/Button.vue';

const REFRESH_INTERVAL_MS = 60_000;

const router = useRouter();
const overview = ref<AdminOverview | null>(null);
const jobs = ref<AdminJob[]>([]);
const health = ref<HealthResponse | null>(null);
const overviewError = ref<string | null>(null);
const jobsError = ref<string | null>(null);
const healthError = ref<string | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const refreshedAt = ref<Date | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const jobStatuses = computed(() =>
  Object.entries(overview.value?.jobs.by_status ?? {})
    .map(([status, count]) => [status as AdminJobStatus, count] as const)
    .sort((a, b) => b[1] - a[1]),
);
const outcomeStatuses = computed(() =>
  Object.entries(overview.value?.outcomes.by_status ?? {})
    .map(([status, count]) => [status as ErrorGroupStatus, count] as const)
    .sort((a, b) => b[1] - a[1]),
);
const funnelStages = computed(() => overview.value?.onboarding
  ? onboardingFunnelStages(overview.value.onboarding)
  : [],
);
const onboardingFailureReasons = computed(() =>
  Object.entries(overview.value?.onboarding?.by_failure_reason ?? {}).sort((a, b) => b[1] - a[1]),
);
const healthChecks = computed(() => Object.entries(health.value?.checks ?? {}));
const jobsWithLinks = computed(() => jobs.value.map((job) => ({
  ...job,
  traceHref: safeUrl(job.trace_url),
  prHref: safeUrl(job.pr_url, GITHUB_PR_URL_OPTIONS),
})));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadDashboard(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  overviewError.value = null;
  jobsError.value = null;
  healthError.value = null;

  try {
    const [overviewResult, jobsResult, healthResult] = await Promise.allSettled([
      getAdminOverview(),
      listAdminJobs(),
      getHealth(),
    ]);

    if (overviewResult.status === 'rejected') {
      if (overviewResult.reason instanceof APIError && overviewResult.reason.status === 404) {
        await router.replace('/');
        return;
      }
      overviewError.value = `Failed to load overview: ${errorMessage(overviewResult.reason)}`;
    } else {
      overview.value = overviewResult.value;
    }

    if (jobsResult.status === 'rejected') {
      jobsError.value = `Failed to load recent jobs: ${errorMessage(jobsResult.reason)}`;
    } else {
      jobs.value = jobsResult.value.jobs;
    }

    if (healthResult.status === 'rejected') {
      healthError.value = `Health check unavailable: ${errorMessage(healthResult.reason)}`;
    } else {
      health.value = healthResult.value;
    }

    refreshedAt.value = new Date();
  } finally {
    refreshing.value = false;
    loading.value = false;
  }
}

onMounted(() => {
  void loadDashboard();
  refreshTimer = setInterval(() => void loadDashboard(), REFRESH_INTERVAL_MS);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-text">System observability</h1>
        <p class="mt-1 text-sm text-muted">
          Cross-project event flow, investigation outcomes, and worker activity.
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span v-if="refreshedAt" class="text-xs text-muted">
          Updated {{ refreshedAt.toLocaleTimeString() }}
        </span>
        <Button variant="secondary" :disabled="refreshing" @click="loadDashboard">
          {{ refreshing ? 'Refreshing\u2026' : 'Refresh' }}
        </Button>
      </div>
    </div>

    <div
      v-if="overviewError"
      class="rounded-md border border-danger/20 bg-danger/10 p-4 text-sm text-danger"
      v-text="overviewError"
    ></div>

    <div v-if="loading && !overview" class="py-12 text-center text-sm text-muted">
      Loading operator metrics…
    </div>

    <template v-if="overview">
      <section aria-label="Headline metrics" class="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <div class="rounded-lg border border-border bg-surface p-4">
          <p class="text-xs text-muted">Events 1h</p>
          <p class="mt-2 text-2xl font-semibold tabular-nums">{{ overview.events.last_1h.toLocaleString() }}</p>
        </div>
        <div class="rounded-lg border border-border bg-surface p-4">
          <p class="text-xs text-muted">Events 24h</p>
          <p class="mt-2 text-2xl font-semibold tabular-nums">{{ overview.events.last_24h.toLocaleString() }}</p>
        </div>
        <div class="rounded-lg border border-border bg-surface p-4">
          <p class="text-xs text-muted">Incidents w/ PR created 7d</p>
          <p class="mt-2 text-2xl font-semibold tabular-nums">{{ overview.outcomes.pr_created_7d.toLocaleString() }}</p>
        </div>
        <div class="rounded-lg border border-border bg-surface p-4">
          <p class="text-xs text-muted">Needs human 7d</p>
          <p class="mt-2 text-2xl font-semibold tabular-nums">{{ overview.outcomes.needs_human_7d.toLocaleString() }}</p>
        </div>
        <div class="rounded-lg border border-border bg-surface p-4">
          <p class="text-xs text-muted">Queue depth (pending)</p>
          <p class="mt-2 text-2xl font-semibold tabular-nums">{{ (overview.jobs.by_status.pending ?? 0).toLocaleString() }}</p>
        </div>
        <div class="rounded-lg border border-border bg-surface p-4">
          <p class="text-xs text-muted">Dead letters 7d</p>
          <p class="mt-2 text-2xl font-semibold tabular-nums">{{ overview.jobs.dead_letters_7d.toLocaleString() }}</p>
        </div>
        <div class="rounded-lg border border-border bg-surface p-4">
          <p class="text-xs text-muted">Workers w/ live claims</p>
          <p class="mt-2 text-2xl font-semibold tabular-nums">{{ overview.workers.live_claims.toLocaleString() }}</p>
        </div>
      </section>

      <section
        v-if="overview.onboarding"
        aria-label="Agent onboarding funnel"
        class="rounded-lg border border-border bg-surface p-5"
      >
        <div>
          <h2 class="text-base font-medium">Agent onboarding (30d) · activation &amp; best-effort</h2>
          <p class="mt-1 text-xs text-muted">
            Auth clicks and key claims are best-effort stamps; activation means the completed session's project has received an event.
          </p>
        </div>
        <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <div
            v-for="stage in funnelStages"
            :key="stage.key"
            class="rounded-lg border border-border bg-surface p-4"
          >
            <p class="text-xs text-muted" v-text="stage.label"></p>
            <p class="mt-2 text-2xl font-semibold tabular-nums">{{ stage.value.toLocaleString() }}</p>
            <p class="mt-1 text-xs text-faint">{{ stage.pctOfFirst }}% of started</p>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>Failed: <strong class="tabular-nums text-text">{{ overview.onboarding.failed.toLocaleString() }}</strong></span>
          <span v-for="([reason, count]) in onboardingFailureReasons" :key="reason">
            {{ reason.replace(/_/g, ' ') }}: <strong class="tabular-nums text-text">{{ count.toLocaleString() }}</strong>
          </span>
        </div>
      </section>

      <section class="rounded-lg border border-border bg-surface p-5">
        <div class="flex items-baseline justify-between gap-4">
          <div>
            <h2 class="text-base font-medium">Event ingestion</h2>
            <p class="mt-1 text-xs text-muted">Hourly event volume over the last 48 hours (UTC)</p>
          </div>
          <span class="text-xs text-muted">7d total: {{ overview.events.last_7d.toLocaleString() }}</span>
        </div>
        <AdminHourlyChart :buckets="overview.events.hourly" />
      </section>

      <section class="grid gap-4 lg:grid-cols-3">
        <div class="rounded-lg border border-border bg-surface p-5">
          <h2 class="text-base font-medium">Jobs by status</h2>
          <div v-if="jobStatuses.length" class="mt-4 flex flex-wrap gap-2">
            <span
              v-for="([status, count]) in jobStatuses"
              :key="status"
              class="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium"
              :class="adminStatusBadgeClass(status)"
            >
              {{ status.replace(/_/g, ' ') }} <strong class="tabular-nums">{{ count }}</strong>
            </span>
          </div>
          <p v-else class="mt-4 text-sm text-muted">No jobs recorded.</p>
          <dl class="mt-5 border-t border-border pt-4 text-xs">
            <div class="flex justify-between gap-4">
              <dt class="text-muted">Oldest pending</dt>
              <dd class="tabular-nums">{{ formatDuration(overview.jobs.oldest_pending_age_seconds) }}</dd>
            </div>
          </dl>
        </div>

        <div class="rounded-lg border border-border bg-surface p-5">
          <h2 class="text-base font-medium">Top projects · 24h</h2>
          <div class="mt-3 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted">
                  <th class="py-2 pr-3 font-medium">Project</th>
                  <th class="py-2 pr-3 font-medium">Organization</th>
                  <th class="py-2 text-right font-medium">Events</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="project in overview.events.top_projects" :key="project.project_id" class="border-b border-border last:border-0">
                  <td class="py-2 pr-3" v-text="project.project_name"></td>
                  <td class="py-2 pr-3 text-muted" v-text="project.org_name"></td>
                  <td class="py-2 text-right tabular-nums">{{ project.count.toLocaleString() }}</td>
                </tr>
                <tr v-if="overview.events.top_projects.length === 0">
                  <td colspan="3" class="py-4 text-center text-muted">No events in the last 24 hours.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="rounded-lg border border-border bg-surface p-5">
          <h2 class="text-base font-medium">Incident outcomes</h2>
          <div class="mt-4 grid grid-cols-2 gap-3">
            <div class="rounded-md bg-surface-subtle p-3">
              <p class="text-xs text-muted">Merged 7d</p>
              <p class="mt-1 text-xl font-semibold tabular-nums">{{ overview.outcomes.merged_7d }}</p>
            </div>
            <div class="rounded-md bg-surface-subtle p-3">
              <p class="text-xs text-muted">Closed 7d</p>
              <p class="mt-1 text-xl font-semibold tabular-nums">{{ overview.outcomes.closed_7d }}</p>
            </div>
            <div class="rounded-md bg-surface-subtle p-3">
              <p class="text-xs text-muted">Spend 7d</p>
              <p class="mt-1 text-xl font-semibold tabular-nums">${{ overview.outcomes.spend_usd_7d.toFixed(2) }}</p>
            </div>
            <div class="rounded-md bg-surface-subtle p-3">
              <p class="text-xs text-muted">Cost / merged PR 7d</p>
              <p class="mt-1 text-xl font-semibold tabular-nums">
                {{ overview.outcomes.cost_per_merged_pr_7d === null ? '—' : '$' + overview.outcomes.cost_per_merged_pr_7d.toFixed(2) }}
              </p>
            </div>
          </div>
          <div class="mt-4 flex flex-wrap gap-2">
            <span
              v-for="([status, count]) in outcomeStatuses"
              :key="status"
              class="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium"
              :class="adminStatusBadgeClass(status)"
            >
              {{ status.replace(/_/g, ' ') }} <strong>{{ count }}</strong>
            </span>
          </div>
        </div>
      </section>
    </template>

    <section class="rounded-lg border border-border bg-surface">
      <div class="border-b border-border px-5 py-4">
        <h2 class="text-base font-medium">Recent jobs</h2>
        <p class="mt-1 text-xs text-muted">Latest work across all projects</p>
      </div>
      <p v-if="jobsError" class="m-5 rounded-md bg-danger/10 p-3 text-sm text-danger" v-text="jobsError"></p>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <th class="px-4 py-2.5 font-medium">Time</th>
              <th class="px-4 py-2.5 font-medium">Project / incident</th>
              <th class="px-4 py-2.5 font-medium">Type</th>
              <th class="px-4 py-2.5 font-medium">Status</th>
              <th class="px-4 py-2.5 text-right font-medium">Attempts</th>
              <th class="px-4 py-2.5 text-right font-medium">Duration</th>
              <th class="px-4 py-2.5 font-medium">Last error</th>
              <th class="px-4 py-2.5 text-right font-medium">Links</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in jobsWithLinks" :key="job.id" class="border-b border-border align-top last:border-0">
              <td class="whitespace-nowrap px-4 py-3 text-muted">{{ formatDate(job.created_at) }}</td>
              <td class="max-w-56 px-4 py-3">
                <p class="truncate" v-text="job.project_name"></p>
                <p v-if="job.incident_title" class="mt-0.5 truncate text-xs text-muted" v-text="job.incident_title"></p>
              </td>
              <td class="whitespace-nowrap px-4 py-3 font-mono text-xs" v-text="job.job_type"></td>
              <td class="px-4 py-3">
                <span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium" :class="adminStatusBadgeClass(job.status)">
                  {{ job.status.replace(/_/g, ' ') }}
                </span>
              </td>
              <td class="px-4 py-3 text-right tabular-nums">{{ job.attempts }}</td>
              <td class="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted">{{ formatDuration(job.duration_seconds) }}</td>
              <td class="max-w-80 px-4 py-3 text-xs text-muted">
                <span class="line-clamp-3 break-words" v-text="job.last_error ?? '\u2014'"></span>
              </td>
              <td class="whitespace-nowrap px-4 py-3 text-right">
                <a
                  v-if="job.traceHref"
                  :href="job.traceHref"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-accent hover:underline"
                  aria-label="Open Langfuse trace"
                >Trace ⧉</a>
                <a
                  v-if="job.prHref"
                  :href="job.prHref"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="ml-3 text-accent hover:underline"
                  aria-label="Open pull request"
                >PR ⧉</a>
                <span v-if="!job.traceHref && !job.prHref" class="text-faint">—</span>
              </td>
            </tr>
            <tr v-if="jobs.length === 0 && !loading">
              <td colspan="8" class="px-4 py-8 text-center text-muted">No jobs recorded.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="rounded-lg border border-border bg-surface p-5">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 class="text-base font-medium">Service health</h2>
          <p class="mt-1 text-xs text-muted">Ingestion, database, and object storage</p>
        </div>
        <span
          v-if="health"
          class="inline-flex rounded-full px-2.5 py-1 text-xs font-medium"
          :class="health.status === 'ok' ? 'bg-success/10 text-success' : health.status === 'degraded' ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger'"
          v-text="health.status"
        ></span>
      </div>
      <p v-if="healthError" class="mt-4 text-sm text-danger" v-text="healthError"></p>
      <div v-else-if="health" class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-md bg-surface-subtle p-3">
          <p class="text-xs text-muted">Ingestion</p>
          <p class="mt-1 text-sm font-medium" v-text="health.status"></p>
          <p class="mt-1 text-xs text-faint">v{{ health.version }} · up {{ formatDuration(health.uptime_seconds) }}</p>
        </div>
        <div v-for="([name, check]) in healthChecks" :key="name" class="rounded-md bg-surface-subtle p-3">
          <p class="text-xs capitalize text-muted" v-text="name"></p>
          <p class="mt-1 text-sm font-medium" :class="check.status === 'ok' ? 'text-success' : 'text-danger'" v-text="check.status"></p>
          <p v-if="check.latency_ms !== undefined" class="mt-1 text-xs text-faint">{{ check.latency_ms.toFixed(1) }}ms</p>
          <p v-if="check.error" class="mt-1 break-words text-xs text-danger" v-text="check.error"></p>
        </div>
        <div v-if="overview" class="rounded-md bg-surface-subtle p-3">
          <p class="text-xs text-muted">Workers active in last 5m</p>
          <p class="mt-1 text-sm font-medium tabular-nums">{{ overview.workers.active_5m }}</p>
          <p class="mt-1 text-xs text-faint">Heartbeat-derived; an idle fleet may show zero.</p>
        </div>
      </div>
    </section>
  </div>
</template>
