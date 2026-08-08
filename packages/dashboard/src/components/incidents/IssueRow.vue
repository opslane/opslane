<script setup lang="ts">
import { computed } from 'vue';
import type { Incident } from '../../types/api';
import { formatCompactAge, formatDate, GITHUB_PR_URL_OPTIONS, safeUrl } from '../../utils';
import { kindBadge } from '../incident-kind';
import { platformBadge } from '../platform-badge';
import StatusLabel from '../ui/StatusLabel.vue';
import { incidentStatusRecipe } from '../../status-recipes';
import PriorityReason from './PriorityReason.vue';

const props = withDefaults(defineProps<{
  incident: Incident;
  projectId: string;
  layout?: 'table' | 'stacked';
  showPlatform?: boolean;
  environmentFiltered?: boolean;
  projectHasIdentify?: boolean;
}>(), {
  layout: 'table',
  showPlatform: false,
  environmentFiltered: false,
  projectHasIdentify: false,
});

// Error is the default kind and says nothing in a dense queue. Friction rows
// keep their marker, including the "Unchecked" adjudication diagnostic.
const kind = computed(() => props.incident.kind === 'error'
  ? null
  : kindBadge(props.incident.kind, props.incident.adjudication_status));
const platform = computed(() => platformBadge(props.incident.platform));
const status = computed(() => incidentStatusRecipe(props.incident.status));
const prUrl = computed(() => safeUrl(props.incident.pr_url, GITHUB_PR_URL_OPTIONS));
const showMarkers = computed(() => kind.value || (props.showPlatform && platform.value));
</script>

<template>
  <article
    v-if="layout === 'stacked'"
    class="border-b border-border px-4 py-4 last:border-b-0 hover:bg-surface-subtle"
    data-testid="stacked-issue"
  >
    <router-link
      :to="{ name: 'incident', params: { id: incident.id }, query: { project_id: projectId } }"
      :title="incident.title"
      class="line-clamp-2 block text-sm font-semibold leading-5 text-text decoration-accent underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      v-text="incident.title"
    />
    <div
      v-if="showMarkers"
      class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-faint"
    >
      <span v-if="kind" data-testid="kind-marker" v-text="kind.label"></span>
      <span v-if="kind && showPlatform && platform" aria-hidden="true">·</span>
      <span
        v-if="showPlatform && platform"
        data-testid="platform-marker"
        v-text="platform.label"
      ></span>
    </div>
    <PriorityReason
      :incident="incident"
      :environment-filtered="environmentFiltered"
      :project-has-identify="projectHasIdentify"
    />
    <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <a
        v-if="prUrl"
        :href="prUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="pr-link"
        :aria-label="`${status.label}, opens pull request on GitHub`"
        class="inline-block rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <StatusLabel :tone="status.tone" :label="status.label">
          {{ status.label }}<span aria-hidden="true" class="ml-1">↗</span>
        </StatusLabel>
      </a>
      <StatusLabel v-else :tone="status.tone" :label="status.label" />
      <span aria-hidden="true">·</span>
      <span>{{ incident.affected_users_count.toLocaleString() }} users</span>
      <span aria-hidden="true">·</span>
      <span data-testid="age">{{ formatCompactAge(incident.first_seen) }}</span>
    </div>
  </article>

  <tr v-else class="group border-b border-border last:border-b-0 hover:bg-surface-subtle">
    <td class="min-w-0 px-4 py-4 sm:px-5">
      <router-link
        :to="{ name: 'incident', params: { id: incident.id }, query: { project_id: projectId } }"
        :title="incident.title"
        class="line-clamp-2 block min-w-0 max-w-xl text-sm font-semibold leading-5 text-text decoration-accent underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        v-text="incident.title"
      />
      <div
        v-if="showMarkers"
        class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint"
      >
        <span v-if="kind" data-testid="kind-marker" v-text="kind.label"></span>
        <span v-if="kind && showPlatform && platform" aria-hidden="true">·</span>
        <span
          v-if="showPlatform && platform"
          data-testid="platform-marker"
          v-text="platform.label"
        ></span>
      </div>
      <PriorityReason
        :incident="incident"
        :environment-filtered="environmentFiltered"
        :project-has-identify="projectHasIdentify"
      />
    </td>
    <td class="px-4 py-4">
      <a
        v-if="prUrl"
        :href="prUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="pr-link"
        :aria-label="`${status.label}, opens pull request on GitHub`"
        class="inline-block rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <StatusLabel :tone="status.tone" :label="status.label">
          {{ status.label }}<span aria-hidden="true" class="ml-1">↗</span>
        </StatusLabel>
      </a>
      <StatusLabel v-else :tone="status.tone" :label="status.label" />
    </td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted sm:table-cell">
      {{ incident.occurrence_count.toLocaleString() }}
    </td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted lg:table-cell">
      {{ incident.affected_users_count.toLocaleString() }}
    </td>
    <td class="hidden px-4 py-4 text-right text-sm tabular-nums text-muted lg:table-cell" data-testid="age">
      {{ formatCompactAge(incident.first_seen) }}
    </td>
    <td class="hidden px-4 py-4 text-right text-sm text-muted xl:table-cell" data-testid="last-seen">
      <div class="flex items-center justify-end gap-3">
        <span>{{ formatDate(incident.last_seen) }}</span>
        <span aria-hidden="true" class="text-lg leading-5 text-faint">›</span>
      </div>
    </td>
  </tr>
</template>
