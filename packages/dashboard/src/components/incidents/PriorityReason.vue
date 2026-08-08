<script setup lang="ts">
import { computed } from 'vue';
import type { Incident } from '../../types/api';

const props = defineProps<{
  incident: Incident;
  environmentFiltered: boolean;
  projectHasIdentify: boolean;
}>();

const inputs = computed(() => props.incident.priority_inputs);
const unscored = computed(
  () => props.incident.priority_score == null && props.incident.priority_scored_at == null,
);

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

const reach = computed(() => {
  if (!inputs.value || unscored.value) return null;

  const parts: string[] = [];
  if (inputs.value.users_7d > 0) {
    parts.push(countLabel(inputs.value.users_7d, 'known user', 'known users'));
  }
  if (inputs.value.anon_sessions_7d > 0) {
    parts.push(countLabel(
      inputs.value.anon_sessions_7d,
      'anonymous session',
      'anonymous sessions',
    ));
  }

  let value = parts.length > 0 ? `${parts.join(' + ')} this week` : 'Quiet this week';
  const today = inputs.value.users_24h + inputs.value.anon_sessions_24h;
  if (today > 0) value += ` · ${today.toLocaleString()} today`;
  if (props.environmentFiltered) value += ' · project-wide';
  return value;
});

const route = computed(() => inputs.value?.route_name ?? inputs.value?.route_pattern ?? null);
const routeAudience = computed(() => {
  switch (inputs.value?.route_tier) {
    case 'customer': return 'your customers see this page';
    case 'admin': return 'internal config page';
    default: return null;
  }
});
const identifyHint = computed(() => {
  if (!inputs.value || inputs.value.anon_sessions_7d <= inputs.value.users_7d) return null;
  return props.projectHasIdentify
    ? 'identify() is wired elsewhere in your app but not on this page.'
    : 'No user identification on this page — counting sessions.';
});
</script>

<template>
  <div class="mt-1.5 space-y-1 text-xs leading-5 text-muted" data-testid="priority-reason">
    <p v-if="unscored">Not scored yet</p>
    <template v-else>
      <p v-if="route" class="text-faint">
        <span v-text="route"></span><template v-if="routeAudience"> · <span v-text="routeAudience"></span></template>
      </p>
      <p v-if="reach" v-text="reach"></p>
      <p v-if="identifyHint" class="text-faint" v-text="identifyHint"></p>
      <template v-if="inputs?.cap_applied">
        <p class="text-faint">The agent can't fix this class (ranked down).</p>
        <p v-if="incident.reason?.remediation" class="text-faint" v-text="incident.reason.remediation"></p>
      </template>
    </template>
  </div>
</template>
