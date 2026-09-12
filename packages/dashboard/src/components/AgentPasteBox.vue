<script setup lang="ts">
import CopyButton from './CopyButton.vue';

withDefaults(defineProps<{ variant?: 'wizard' | 'empty' }>(), { variant: 'empty' });
const line = 'Set up https://docs.opslane.com/INSTALL.md';
</script>

<template>
  <div class="rounded-lg border border-border bg-surface p-4 text-left" data-testid="agent-paste-box">
    <p class="text-sm font-medium text-text">Paste into your agent</p>
    <p class="mt-1 text-xs text-muted">Claude Code, Codex, Cursor, or any agent with a shell. It installs the SDK, proves the first event, and guides you through optional integrations.</p>
    <div class="mt-3 flex items-center gap-3 rounded bg-black px-4 py-3 font-mono text-sm text-white">
      <span class="text-muted">&gt;</span>
      <span class="flex-1 truncate" data-testid="agent-paste-line">{{ line }}</span>
      <CopyButton :text="line" />
    </div>
    <p v-if="variant === 'wizard'" class="mt-3 text-xs text-muted"><slot name="manual">Prefer to do it by hand? The snippet is below.</slot></p>
    <p v-else class="mt-3 text-xs text-muted">Prefer the manual setup? <router-link to="/setup" class="text-accent hover:underline">Setup guide</router-link></p>
  </div>
</template>
