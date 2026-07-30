<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  listProjects,
  createProject,
  updateProject,
  getFixStats,
  listEnvironments,
  createEnvironment,
  getGitHubConfig,
  setGitHubConfig,
  deleteGitHubConfig,
  getGitHubAppStatus,
  getMe,
  type Project,
  type Environment,
  type FixStats,
  type ProjectProvisioningResponse,
} from '../api';
import type { AuthMembership, GitHubConfig, GitHubAppStatus } from '../types/api';
import { formatDate, safeUrl } from '../utils';
import CopyButton from '../components/CopyButton.vue';
import IntegrationsSettings from '../components/IntegrationsSettings.vue';
import RepoSelector from '../components/RepoSelector.vue';
import InvitationsPanel from '../components/InvitationsPanel.vue';
import ModalSurface from '../components/ui/ModalSurface.vue';
import Button from '../components/ui/Button.vue';
import TextInput from '../components/ui/TextInput.vue';
import TabList from '../components/ui/TabList.vue';
import {
  canDismissProvisionedKey,
  createProvisioningAttempt,
} from '../components/project-provisioning';
import {
  applyProjectSelection,
  projectSwitchQuery,
} from '../components/project-switcher';

type SettingsTab = 'project' | 'environments' | 'api-keys' | 'integrations' | 'organization';
const route = useRoute();
const router = useRouter();
const activeTab = ref<SettingsTab>('project');
const activeRole = ref<AuthMembership['role']>();
const activeRoleResolved = ref(false);
const settingsTabs = computed(() => [
  { id: 'project', label: 'Project' },
  { id: 'environments', label: 'Environments' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'integrations', label: 'Integrations' },
  ...(activeRole.value ? [{ id: 'organization', label: 'Organization' }] : []),
]);

function selectSettingsTab(value: string): void {
  if (['project', 'environments', 'api-keys', 'integrations', 'organization'].includes(value)) {
    switchTab(value as SettingsTab);
  }
}

// Project tab
const projects = ref<Project[]>([]);
const selectedProjectId = ref(localStorage.getItem('opslane_project_id') ?? '');
const loadingProjects = ref(true);
const showNewProjectForm = ref(false);
const newProjectName = ref('');
const newProjectRepo = ref('');
const projectAttemptToken = ref('');
const creatingProject = ref(false);
const projectCreateError = ref('');
const provisionedProject = ref<ProjectProvisioningResponse | null>(null);
const provisioningKeyAcknowledged = ref(false);
const canProvision = computed(() =>
  !activeRole.value || activeRole.value === 'admin' || activeRole.value === 'owner',
);
const canManagePayloadEnvironment = computed(() =>
  activeRoleResolved.value
    && (!activeRole.value || activeRole.value === 'admin' || activeRole.value === 'owner'),
);

// Friction autonomy
const autonomyOptions = [
  {
    value: 'ask_first',
    label: 'Ask first (default)',
    description: 'Friction fixes wait in awaiting-approval until you click Generate fix.',
  },
  {
    value: 'auto_fix',
    label: 'Auto-fix',
    description: 'High-confidence, code-caused friction goes straight to a Suggestion PR.',
  },
  {
    value: 'auto_fix_ux',
    label: 'Auto-fix incl. UX suggestions',
    description: 'Same as auto-fix today; reserved for UX-suggestion fixes when they ship.',
  },
] as const;

const selectedProject = computed(() =>
  projects.value.find((project) => project.id === selectedProjectId.value) ?? null,
);
const activeProjectName = computed(() =>
  selectedProject.value?.name ?? localStorage.getItem('opslane_project_name') ?? 'No project selected',
);
const autonomy = ref<Project['friction_autonomy']>('ask_first');
const autonomySaving = ref(false);
const autonomyError = ref('');
const prPosture = ref<Project['pr_posture']>('verified_only');
const prPostureSaving = ref(false);
const prPostureError = ref('');
const allowPayloadEnvironment = ref(false);
const payloadEnvironmentSaving = ref(false);
const payloadEnvironmentError = ref('');
const fixStats = ref<Record<'error' | 'friction', FixStats> | null>(null);
let statsRequestToken = 0;
let autonomySaveToken = 0;
let prPostureSaveToken = 0;
let payloadEnvironmentSaveToken = 0;
let lastLoadedProjectId: string | null = null;

// Environments tab
const environments = ref<Environment[]>([]);
const loadingEnvs = ref(false);
const newEnvName = ref('');
const creatingEnv = ref(false);
const envError = ref('');

// GitHub integration
const githubConfig = ref<GitHubConfig | null>(null);
const loadingGithub = ref(false);
const githubAppStatus = ref<GitHubAppStatus | null>(null);
const selectedRepo = ref('');
const connectingGithub = ref(false);
const disconnectingGithub = ref(false);
const githubError = ref('');

onMounted(async () => {
  getMe().then((user) => {
    activeRole.value = user.active_role;
    activeRoleResolved.value = true;
  }).catch(() => {});
  try {
    projects.value = await listProjects();
    // Load GitHub App status + per-project config
    loadGitHubAppStatus();
    if (selectedProjectId.value) {
      loadGitHubConfig(selectedProjectId.value);
    }
  } catch {
    // The active project remains available from local storage; project-scoped
    // requests below will surface their own failures.
  } finally {
    loadingProjects.value = false;
  }
});

watch(selectedProjectId, () => {
  // Invalidate an in-flight save for the previously selected project so its
  // completion cannot overwrite the new project's displayed state.
  autonomySaveToken += 1;
  autonomySaving.value = false;
  prPostureSaveToken += 1;
  prPostureSaving.value = false;
  payloadEnvironmentSaveToken += 1;
  payloadEnvironmentSaving.value = false;
  void loadAutonomyAndStats();
}, { immediate: true });
watch(projects, () => {
  // The projects list changes in two ways: the async load on mount (the
  // selected project appears — fetch its stats) and a completed save (same
  // project, only friction_autonomy changed — re-sync the toggle without
  // refetching stats, which would flicker the receipts for nothing).
  autonomy.value = selectedProject.value?.friction_autonomy ?? 'ask_first';
  prPosture.value = selectedProject.value?.pr_posture ?? 'verified_only';
  allowPayloadEnvironment.value = selectedProject.value?.allow_payload_environment ?? false;
  if ((selectedProject.value?.id ?? null) !== lastLoadedProjectId) {
    void loadAutonomyAndStats();
  }
});

async function loadAutonomyAndStats(): Promise<void> {
  const token = ++statsRequestToken;
  autonomyError.value = '';
  prPostureError.value = '';
  payloadEnvironmentError.value = '';
  fixStats.value = null;
  autonomy.value = selectedProject.value?.friction_autonomy ?? 'ask_first';
  prPosture.value = selectedProject.value?.pr_posture ?? 'verified_only';
  allowPayloadEnvironment.value = selectedProject.value?.allow_payload_environment ?? false;

  const id = selectedProjectId.value;
  lastLoadedProjectId = selectedProject.value?.id ?? null;
  if (!id || !selectedProject.value) return;

  try {
    const stats = await getFixStats(id);
    if (token === statsRequestToken) {
      fixStats.value = stats;
    }
  } catch {
    // Stats are best-effort; the autonomy setting works without them.
  }
}

function openNewProjectForm(): void {
  showNewProjectForm.value = true;
  projectCreateError.value = '';
  projectAttemptToken.value = createProvisioningAttempt(() => crypto.randomUUID()).idempotencyToken;
}

function cancelNewProjectForm(): void {
  if (creatingProject.value) return;
  showNewProjectForm.value = false;
  newProjectName.value = '';
  newProjectRepo.value = '';
  projectAttemptToken.value = '';
  projectCreateError.value = '';
}

async function handleCreateProject(): Promise<void> {
  if (!newProjectName.value.trim() || !projectAttemptToken.value || creatingProject.value) return;
  creatingProject.value = true;
  projectCreateError.value = '';
  try {
    const result = await createProject(
      newProjectName.value.trim(),
      newProjectRepo.value.trim(),
      projectAttemptToken.value,
    );
    provisionedProject.value = result;
    provisioningKeyAcknowledged.value = false;
    projects.value = [
      ...projects.value.filter((project) => project.id !== result.project.id),
      result.project,
    ];
    showNewProjectForm.value = false;
  } catch (caught: unknown) {
    projectCreateError.value = caught instanceof Error
      ? caught.message
      : 'Failed to create project';
  } finally {
    creatingProject.value = false;
  }
}

async function dismissProvisionedProject(): Promise<void> {
  if (!canDismissProvisionedKey(provisioningKeyAcknowledged.value)) return;
  const result = provisionedProject.value;
  if (!result) return;

  applyProjectSelection(localStorage, result.project);
  await router.push({ path: '/', query: projectSwitchQuery(route.query) });
  window.dispatchEvent(new Event('opslane-projects-changed'));

  provisionedProject.value = null;
  provisioningKeyAcknowledged.value = false;
  newProjectName.value = '';
  newProjectRepo.value = '';
  projectAttemptToken.value = '';
}

async function savePRPosture(value: Project['pr_posture']): Promise<void> {
  if (!selectedProject.value) return;

  const projectId = selectedProject.value.id;
  const saveToken = ++prPostureSaveToken;
  const previous = prPosture.value;
  prPosture.value = value;
  prPostureSaving.value = true;
  prPostureError.value = '';
  try {
    const updated = await updateProject(projectId, { pr_posture: value });
    projects.value = projects.value.map((project) =>
      project.id === updated.id ? updated : project,
    );
  } catch (err: unknown) {
    if (saveToken === prPostureSaveToken && selectedProjectId.value === projectId) {
      prPosture.value = previous;
      prPostureError.value = err instanceof Error
        ? err.message
        : 'Failed to save pull request posture';
    }
  } finally {
    if (saveToken === prPostureSaveToken) {
      prPostureSaving.value = false;
    }
  }
}

function onPRPostureChange(event: Event): void {
  const checked = event.target instanceof HTMLInputElement && event.target.checked;
  void savePRPosture(checked ? 'draft_when_unverified' : 'verified_only');
}

async function savePayloadEnvironment(value: boolean): Promise<void> {
  if (!selectedProject.value || !canManagePayloadEnvironment.value) return;

  const projectId = selectedProject.value.id;
  const saveToken = ++payloadEnvironmentSaveToken;
  const previous = allowPayloadEnvironment.value;
  allowPayloadEnvironment.value = value;
  payloadEnvironmentSaving.value = true;
  payloadEnvironmentError.value = '';
  try {
    const updated = await updateProject(projectId, { allow_payload_environment: value });
    projects.value = projects.value.map((project) =>
      project.id === updated.id ? updated : project,
    );
  } catch (err: unknown) {
    if (saveToken === payloadEnvironmentSaveToken && selectedProjectId.value === projectId) {
      allowPayloadEnvironment.value = previous;
      payloadEnvironmentError.value = err instanceof Error
        ? err.message
        : 'Failed to save SDK environment override setting';
    }
  } finally {
    if (saveToken === payloadEnvironmentSaveToken) {
      payloadEnvironmentSaving.value = false;
    }
  }
}

function onPayloadEnvironmentChange(event: Event): void {
  const checked = event.target instanceof HTMLInputElement && event.target.checked;
  void savePayloadEnvironment(checked);
}

async function saveAutonomy(value: Project['friction_autonomy']): Promise<void> {
  if (!selectedProject.value) return;

  const projectId = selectedProject.value.id;
  const saveToken = ++autonomySaveToken;
  const previous = autonomy.value;
  autonomy.value = value;
  autonomySaving.value = true;
  autonomyError.value = '';
  try {
    const updated = await updateProject(projectId, { friction_autonomy: value });
    projects.value = projects.value.map((project) =>
      project.id === updated.id ? updated : project,
    );
  } catch (err: unknown) {
    if (saveToken === autonomySaveToken && selectedProjectId.value === projectId) {
      autonomy.value = previous;
      autonomyError.value = err instanceof Error
        ? err.message
        : 'Failed to save autonomy setting';
    }
  } finally {
    if (saveToken === autonomySaveToken) {
      autonomySaving.value = false;
    }
  }
}

function optionStats(value: Project['friction_autonomy']): string {
  const stats = fixStats.value?.friction;
  if (!stats) return '';

  switch (value) {
    case 'ask_first':
      return `${stats.generated_human} friction fixes requested by you`;
    case 'auto_fix':
      // Attempts, not delivered PRs: a job can park or dead-end before a PR.
      // The merged/closed splits count auto-triggered PRs only.
      return `${stats.generated_auto} auto fix attempts · ${stats.prs_merged_auto} merged · ${stats.prs_closed_auto} closed without merge`;
    case 'auto_fix_ux':
      return 'Shares the auto-fix path today — activity is counted under Auto-fix';
  }
}

function switchTab(tab: SettingsTab): void {
  activeTab.value = tab;
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (tab === 'environments' && environments.value.length === 0 && pid) {
    loadEnvironments(pid);
  }
}

async function loadEnvironments(pid: string): Promise<void> {
  loadingEnvs.value = true;
  try {
    environments.value = (await listEnvironments(pid)).environments;
  } catch {
    // Non-fatal
  } finally {
    loadingEnvs.value = false;
  }
}

async function handleCreateEnvironment(): Promise<void> {
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (!pid || !newEnvName.value.trim()) return;
  creatingEnv.value = true;
  envError.value = '';
  try {
    const env = await createEnvironment(pid, newEnvName.value.trim());
    environments.value.push(env);
    newEnvName.value = '';
  } catch (err: unknown) {
    envError.value = err instanceof Error ? err.message : 'Failed to create environment';
  } finally {
    creatingEnv.value = false;
  }
}

async function loadGitHubConfig(pid: string): Promise<void> {
  loadingGithub.value = true;
  try {
    githubConfig.value = await getGitHubConfig(pid);
  } catch {
    // Non-fatal
  } finally {
    loadingGithub.value = false;
  }
}

async function loadGitHubAppStatus(): Promise<void> {
  try {
    githubAppStatus.value = await getGitHubAppStatus();
  } catch {
    // Non-fatal
  }
}

async function handleConnectGithub(): Promise<void> {
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (!pid || !selectedRepo.value) return;
  connectingGithub.value = true;
  githubError.value = '';
  try {
    githubConfig.value = await setGitHubConfig(pid, {
      github_repo: selectedRepo.value,
    });
    selectedRepo.value = '';
  } catch (err: unknown) {
    githubError.value = err instanceof Error ? err.message : 'Failed to connect GitHub';
  } finally {
    connectingGithub.value = false;
  }
}

async function handleDisconnectGithub(): Promise<void> {
  const pid = selectedProjectId.value || localStorage.getItem('opslane_project_id') || '';
  if (!pid) return;
  disconnectingGithub.value = true;
  try {
    await deleteGitHubConfig(pid);
    githubConfig.value = null;
  } catch {
    // Non-fatal
  } finally {
    disconnectingGithub.value = false;
  }
}

</script>

<template>
  <div class="max-w-3xl">
    <h2 class="text-lg font-medium text-text mb-4">Settings</h2>

    <TabList
      class="mb-6"
      :model-value="activeTab"
      :tabs="settingsTabs"
      label="Settings sections"
      id-prefix="settings"
      @update:model-value="selectSettingsTab"
    />

    <!-- Project tab -->
    <div v-if="activeTab === 'project'" id="settings-project-panel" role="tabpanel" aria-labelledby="settings-project-tab" tabindex="0" class="max-w-lg">
      <p class="text-sm text-muted mb-6">
        Configure your active project. This determines which project's incidents you
        see in the activity feed.
      </p>

      <div v-if="canProvision" class="mb-6">
        <Button variant="primary" v-if="!showNewProjectForm" @click="openNewProjectForm">
          New project
        </Button>
        <form
          v-else
          class="space-y-3 rounded-lg border border-border bg-surface p-4"
          @submit.prevent="handleCreateProject"
        >
          <h3 class="text-sm font-medium text-text">Create project</h3>
          <TextInput v-model="newProjectName" label="Name" name="new-project-name" maxlength="100" required />
          <TextInput v-model="newProjectRepo" label="GitHub repository (optional)" name="new-project-repo" placeholder="owner/repository" />
          <p v-if="projectCreateError" class="text-sm text-danger" v-text="projectCreateError"></p>
          <div class="flex gap-3">
            <Button variant="primary" type="submit" :disabled="creatingProject || !newProjectName.trim()">
              {{ creatingProject ? 'Creating...' : 'Create project' }}
            </Button>
            <Button variant="secondary" :disabled="creatingProject" @click="cancelNewProjectForm">
              Cancel
            </Button>
          </div>
        </form>
      </div>

      <div v-if="loadingProjects" class="text-sm text-muted">Loading projects...</div>

      <div v-else class="rounded-lg border border-border bg-surface p-4">
        <div class="text-xs font-medium uppercase tracking-wide text-muted">Active project</div>
        <div class="mt-1 text-sm font-medium text-text">
          {{ activeProjectName }}
        </div>
        <p class="mt-2 text-xs text-muted">
          Use the project switcher in the header to change projects safely.
        </p>
      </div>

      <!-- GitHub Integration -->
      <div class="mt-8 pt-6 border-t border-border">
        <h3 class="text-sm font-medium text-text mb-1">GitHub Integration</h3>
        <p class="text-sm text-muted mb-3">
          Install the Opslane GitHub App and select a repository to enable automated fix PRs.
        </p>

        <div v-if="loadingGithub" class="text-sm text-muted">Loading...</div>

        <!-- GitHub App not installed -->
        <div v-else-if="!githubAppStatus?.installed" class="space-y-3">
          <p class="text-sm text-muted">
            The Opslane GitHub App needs to be installed on your organization to access repositories.
          </p>
          <a
            v-if="githubAppStatus?.install_url"
            :href="safeUrl(githubAppStatus.install_url)"
            class="inline-flex items-center gap-2 inline-flex min-h-10 items-center justify-center border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            <svg class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M10 0C4.477 0 0 4.477 0 10c0 4.42 2.865 8.166 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C17.137 18.163 20 14.418 20 10c0-5.523-4.477-10-10-10z" clip-rule="evenodd" />
            </svg>
            Install GitHub App
          </a>
        </div>

        <!-- GitHub App installed -->
        <div v-else class="space-y-4">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-success/10 text-success">
              GitHub App installed
            </span>
          </div>

          <div class="rounded-md border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
            Draft PR verification requires the GitHub App's <strong>Checks: read</strong>
            permission. If you installed the App before this permission was added, approve
            the permission upgrade in GitHub. Until then, drafts stay drafts and show a
            permission warning instead of being promoted automatically.
          </div>

          <!-- Repo connected -->
          <div v-if="githubConfig?.connected" class="space-y-3">
            <div class="flex items-center gap-3">
              <span class="text-sm text-muted">Repository:</span>
              <span class="text-sm text-text font-mono" v-text="githubConfig.github_repo"></span>
            </div>
            <Button variant="dangerSubtle" size="sm" @click="handleDisconnectGithub" :disabled="disconnectingGithub">
              {{ disconnectingGithub ? 'Disconnecting...' : 'Disconnect repo' }}
            </Button>
          </div>

          <!-- Repo not connected — show selector -->
          <div v-else class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-muted mb-1">Repository</label>
              <RepoSelector v-model="selectedRepo" />
            </div>
            <div v-if="githubError" class="text-sm text-danger" v-text="githubError"></div>
            <Button variant="primary" @click="handleConnectGithub" :disabled="connectingGithub || !selectedRepo">
              {{ connectingGithub ? 'Connecting...' : 'Connect repository' }}
            </Button>
          </div>
        </div>
      </div>

      <!-- Pull request posture -->
      <section class="mt-8 p-4 bg-surface border border-border rounded-lg space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 id="pr-posture-heading" class="text-sm font-medium text-text">Draft PRs for unverified fixes</h3>
            <p id="pr-posture-desc" class="mt-1 text-xs text-muted">
              When enabled, a judge-approved fix with a passing build and no negative test
              evidence can be published as a clearly labeled draft. Repository CI must pass
              before Opslane marks it ready for review.
            </p>
          </div>
          <label class="relative inline-flex shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              class="peer sr-only"
              role="switch"
              aria-labelledby="pr-posture-heading"
              aria-describedby="pr-posture-desc"
              :checked="prPosture === 'draft_when_unverified'"
              :disabled="!selectedProject || prPostureSaving"
              @change="onPRPostureChange"
            />
            <span class="h-6 w-11 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5"></span>
          </label>
        </div>
        <p v-if="!selectedProject" class="text-xs text-faint">
          Select one of your projects above to manage draft PR delivery.
          (Manually entered project IDs can't be managed here.)
        </p>
        <p v-else class="text-xs text-faint">
          {{ prPosture === 'draft_when_unverified'
            ? 'Enabled — eligible unverified fixes may open as drafts.'
            : 'Verified only (default) — fixes below the ready bar remain needs-human incidents.' }}
        </p>
        <p v-if="prPostureError" class="text-sm text-danger" v-text="prPostureError"></p>
      </section>

      <!-- SDK-provided environment override -->
      <section class="mt-8 p-4 bg-surface border border-border rounded-lg space-y-3">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 id="payload-environment-heading" class="text-sm font-medium text-text">
              Allow SDK environment override
            </h3>
            <p id="payload-environment-desc" class="mt-1 text-xs text-muted">
              This relaxes the boundary provided by an environment-bound API key. SDK event
              and replay payloads may select any existing environment in this project. Enable
              it only when you trust clients to choose the correct environment.
            </p>
          </div>
          <label class="relative inline-flex shrink-0 items-center" :class="canManagePayloadEnvironment ? 'cursor-pointer' : 'cursor-not-allowed'">
            <input
              type="checkbox"
              class="peer sr-only"
              role="switch"
              aria-labelledby="payload-environment-heading"
              aria-describedby="payload-environment-desc"
              :checked="allowPayloadEnvironment"
              :disabled="!selectedProject || !canManagePayloadEnvironment || payloadEnvironmentSaving"
              @change="onPayloadEnvironmentChange"
            />
            <span class="h-6 w-11 rounded-full bg-border-strong transition-colors peer-checked:bg-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-50 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5"></span>
          </label>
        </div>
        <p v-if="!selectedProject" class="text-xs text-faint">
          Select one of your projects above to manage SDK environment overrides.
        </p>
        <p v-else-if="!canManagePayloadEnvironment" class="text-xs text-faint">
          Only organization admins can change this setting.
        </p>
        <p v-else class="text-xs text-faint">
          {{ allowPayloadEnvironment
            ? 'Enabled — SDK payloads may override the key-bound environment.'
            : 'Disabled (default) — the API key always determines the environment.' }}
        </p>
        <p v-if="payloadEnvironmentError" class="text-sm text-danger" v-text="payloadEnvironmentError"></p>
      </section>

      <!-- Friction autonomy (Batch 5, issue #57) -->
      <section class="mt-8 p-4 bg-surface border border-border rounded-lg space-y-3">
        <div>
          <h3 id="friction-autonomy-heading" class="text-sm font-medium text-text">Friction autonomy</h3>
          <p id="friction-autonomy-desc" class="mt-1 text-xs text-muted">
            How Opslane acts on friction incidents (rage clicks, dead clicks, form abandonment)
            that have a code cause. Error fixes are unaffected.
          </p>
        </div>
        <p v-if="!selectedProject" class="text-xs text-faint">
          Select one of your projects above to manage autonomy.
          (Manually entered project IDs can't be managed here.)
        </p>
        <div
          v-else
          class="space-y-2"
          role="radiogroup"
          aria-labelledby="friction-autonomy-heading"
          aria-describedby="friction-autonomy-desc"
        >
          <label
            v-for="option in autonomyOptions"
            :key="option.value"
            class="flex items-start gap-3 p-3 border rounded-lg transition-colors focus-within:ring-1 focus-within:ring-accent"
            :class="[
              autonomy === option.value
                ? 'border-accent bg-accent/5'
                : 'border-border hover:border-border-strong hover:bg-surface-subtle',
              autonomySaving ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
            ]"
          >
            <input
              type="radio"
              name="friction-autonomy"
              class="mt-0.5"
              :value="option.value"
              :checked="autonomy === option.value"
              :disabled="autonomySaving"
              @change="saveAutonomy(option.value)"
            />
            <span>
              <span class="block text-sm text-text" v-text="option.label"></span>
              <span class="block text-xs text-muted" v-text="option.description"></span>
              <span
                v-if="fixStats"
                class="block mt-1 text-xs text-faint"
                v-text="optionStats(option.value)"
              ></span>
            </span>
          </label>
        </div>
        <p v-if="autonomyError" class="text-sm text-danger" v-text="autonomyError"></p>
      </section>
    </div>

    <!-- Environments tab -->
    <div v-if="activeTab === 'environments'" id="settings-environments-panel" role="tabpanel" aria-labelledby="settings-environments-tab" tabindex="0">
      <div v-if="loadingEnvs" class="text-sm text-muted">Loading environments...</div>

      <div v-else>
        <ul v-if="environments.length > 0" class="space-y-2 mb-6">
          <li
            v-for="env in environments"
            :key="env.id"
            class="flex items-center justify-between bg-surface rounded-lg border border-border px-4 py-3"
          >
            <div>
              <span class="text-sm font-medium text-text" v-text="env.name"></span>
              <span class="ml-2 text-xs text-muted">created {{ formatDate(env.created_at) }}</span>
            </div>
          </li>
        </ul>
        <div v-else class="text-sm text-muted mb-6">No environments yet.</div>

        <form @submit.prevent="handleCreateEnvironment" class="flex gap-3">
          <input
            v-model="newEnvName"
            type="text"
            placeholder="Environment name (e.g. staging)"
            :disabled="creatingEnv"
            class="flex-1 rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-text focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <Button variant="primary" type="submit" :disabled="creatingEnv || !newEnvName.trim()">
            {{ creatingEnv ? 'Creating...' : 'Create environment' }}
          </Button>
        </form>
        <div v-if="envError" class="mt-2 text-sm text-danger" v-text="envError"></div>
      </div>
    </div>

    <!-- API Keys tab -->
    <div v-if="activeTab === 'api-keys'" id="settings-api-keys-panel" role="tabpanel" aria-labelledby="settings-api-keys-tab" tabindex="0">
      <p class="text-sm text-muted">
        API keys are created by <code>opslane onboard</code> in your repository.
        Managing them here is coming with source-map settings.
      </p>
    </div>

    <div v-if="activeTab === 'organization'" id="settings-organization-panel" role="tabpanel" aria-labelledby="settings-organization-tab" tabindex="0">
      <InvitationsPanel :active-role="activeRole" />
    </div>

    <div v-if="activeTab === 'integrations'" id="settings-integrations-panel" role="tabpanel" aria-labelledby="settings-integrations-tab" tabindex="0">
      <IntegrationsSettings :project-id="selectedProjectId" />
    </div>

    <!-- One-time project provisioning key -->
    <ModalSurface
      :open="Boolean(provisionedProject)"
      title="Project created"
      description="The production environment is ready. Save this API key now; it cannot be shown again."
      :close-on-overlay="false"
    >
      <template v-if="provisionedProject">
        <div class="mt-4 rounded-lg bg-surface-subtle text-text p-4 font-mono text-sm break-all relative">
          <span v-text="provisionedProject.api_key.raw_key"></span>
          <div class="absolute top-2 right-2">
            <CopyButton :text="provisionedProject.api_key.raw_key" />
          </div>
        </div>
        <label class="mt-4 flex items-start gap-2 text-sm text-muted">
          <input v-model="provisioningKeyAcknowledged" type="checkbox" class="mt-0.5" />
          <span>I have copied and stored this key securely.</span>
        </label>
        <Button variant="primary" class="mt-4 w-full" :disabled="!canDismissProvisionedKey(provisioningKeyAcknowledged)" @click="dismissProvisionedProject">
          Done
        </Button>
      </template>
    </ModalSurface>

  </div>
</template>
