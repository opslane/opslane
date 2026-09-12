<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { listGitHubRepos } from '../api';
import type { GitHubRepo } from '../types/api';

defineProps<{
  modelValue: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
	'load-error': [error: unknown];
}>();

const repos = ref<GitHubRepo[]>([]);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    repos.value = await listGitHubRepos();
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : 'Failed to load repositories';
		emit('load-error', err);
  } finally {
    loading.value = false;
  }
});

function onSelect(event: Event): void {
  const target = event.target as HTMLSelectElement;
  emit('update:modelValue', target.value);
}
</script>

<template>
  <div>
    <div v-if="loading" class="text-sm text-muted">Loading repositories...</div>
    <div v-else-if="error" class="text-sm text-danger" v-text="error"></div>
    <div v-else-if="repos.length === 0" class="text-sm text-muted">
      No repositories found. Check your GitHub App permissions.
    </div>
    <select
      v-else
      :value="modelValue"
      @change="onSelect"
      :disabled="disabled"
      class="block w-full rounded-md pl-3 pr-9 py-2 text-sm disabled:opacity-50"
    >
      <option value="" disabled>Select a repository</option>
      <option
        v-for="repo in repos"
        :key="repo.full_name"
        :value="repo.full_name"
      >
        {{ repo.full_name }}
        <template v-if="repo.private"> (private)</template>
      </option>
    </select>
  </div>
</template>
