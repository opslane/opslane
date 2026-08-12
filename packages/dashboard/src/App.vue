<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getMe, isAuthenticated, listProjects, type AuthUser, type Project } from './api';
import { clearClientSession } from './session';
import { routeNeedsProject } from './route-project';
import OrgSwitcher from './components/OrgSwitcher.vue';
import ProjectSwitcher from './components/ProjectSwitcher.vue';
import AppRail from './components/layout/AppRail.vue';
import NavDrawer from './components/layout/NavDrawer.vue';
import { getProjectId } from './utils';

const route = useRoute();
const router = useRouter();
const user = ref<AuthUser | null>(null);
const projectName = ref(localStorage.getItem('opslane_project_name') ?? '');
const projects = ref<Project[]>([]);
const activeProjectId = ref(getProjectId());
const activeProject = computed(() =>
  projects.value.find((project) => project.id === activeProjectId.value) ?? null,
);
const mobileNavOpen = ref(false);
// Session hint, not profile state: getMe() can fail while the local auth flag
// persists, and the user still needs a way to sign out of that stale session.
const signedIn = computed(() => isAuthenticated() || user.value !== null);

// Routes that hide the header and use full-page layout
const fullPageRoutes = ['login', 'register', 'setup', 'auth-complete', 'invite-accept', 'reset-password'];
const isFullPage = computed(() => fullPageRoutes.includes(route.name as string));

async function loadUser(): Promise<void> {
  if (!isAuthenticated()) return;
  try {
    user.value = await getMe();
  } catch {
    user.value = null;
  }
}

async function checkProject(): Promise<void> {
  if (!isAuthenticated()) return;
  try {
    projects.value = await listProjects();
    if (projects.value.length === 0) {
      if (routeNeedsProject(route.name)) await router.push('/setup');
      return;
    }
    const effectiveID = getProjectId();
    const active = projects.value.find((project) => project.id === effectiveID) ?? projects.value[0];
    if (!effectiveID || active.id !== effectiveID) {
      localStorage.setItem('opslane_project_id', active.id);
    }
    localStorage.setItem('opslane_project_name', active.name);
    activeProjectId.value = active.id;
    projectName.value = active.name;
  } catch {
    // Silently ignore -- project listing failed, user can set via Settings
  }
}

function onProjectChange(project: Project): void {
  activeProjectId.value = project.id;
  projectName.value = project.name;
}

function onProjectsChanged(): void {
  void checkProject();
}

async function logout(): Promise<void> {
  await fetch('/api/v1/auth/logout', {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {}); // best-effort server-side revocation
  clearClientSession();
  user.value = null;
  projects.value = [];
  activeProjectId.value = '';
  projectName.value = '';
  router.push('/login');
}

onMounted(() => {
  void loadUser();
  void checkProject();
  window.addEventListener('opslane-projects-changed', onProjectsChanged);
});

onUnmounted(() => {
  window.removeEventListener('opslane-projects-changed', onProjectsChanged);
});

// After login redirect, user ref is still null -- fetch it on route change
watch(
  () => route.name,
  () => {
    if (isAuthenticated() && !user.value) {
      loadUser();
    }
    // Refresh project name from localStorage in case Login.vue just set it
    projectName.value = localStorage.getItem('opslane_project_name') ?? '';
    activeProjectId.value = getProjectId();
    if (isAuthenticated() && projects.value.length === 0) void checkProject();
    mobileNavOpen.value = false;
  }
);
</script>

<template>
  <div class="min-h-screen bg-background font-sans text-text">
    <a
      href="#main-content"
      class="sr-only z-50 rounded-sm bg-accent px-4 py-3 text-sm font-medium text-on-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
    >
      Skip to main content
    </a>

    <template v-if="!isFullPage">
      <AppRail
        v-if="!mobileNavOpen"
        :project-name="projectName"
        :signed-in="signedIn"
        :show-admin="user?.is_admin === true"
        :user-email="user?.email"
        @sign-out="logout"
      >
        <template #workspace>
          <OrgSwitcher
            v-if="user?.memberships?.length"
            :memberships="user.memberships"
            :active-org-id="user.active_org_id ?? user.org_id"
          />
          <ProjectSwitcher
            :projects="projects"
            :active-project-id="activeProjectId"
            @project-change="onProjectChange"
          />
        </template>
      </AppRail>

      <header class="sticky top-0 z-20 flex min-h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
        <router-link
          :to="{ name: 'issues' }"
          class="font-mono text-sm font-semibold uppercase tracking-[0.16em] text-text"
        >
          Opslane
        </router-link>
        <button
          type="button"
          class="inline-flex size-11 items-center justify-center border border-border bg-surface text-text transition-colors duration-150 hover:bg-surface-subtle motion-reduce:transition-none"
          :aria-expanded="mobileNavOpen"
          :aria-label="mobileNavOpen ? 'Close navigation' : 'Open navigation'"
          @click="mobileNavOpen = true"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.75">
            <path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="square" />
          </svg>
        </button>
      </header>

      <NavDrawer
        v-model:open="mobileNavOpen"
        :project-name="projectName"
        :signed-in="signedIn"
        :show-admin="user?.is_admin === true"
        :user-email="user?.email"
        @sign-out="logout"
      >
        <template #workspace>
          <OrgSwitcher
            v-if="user?.memberships?.length"
            :memberships="user.memberships"
            :active-org-id="user.active_org_id ?? user.org_id"
          />
          <ProjectSwitcher
            :projects="projects"
            :active-project-id="activeProjectId"
            @project-change="onProjectChange"
          />
        </template>
      </NavDrawer>
    </template>

    <main
      id="main-content"
      tabindex="-1"
      class="app-main min-w-0"
      :class="!isFullPage ? 'px-4 py-6 sm:px-6 md:ml-56 md:px-8 md:py-8' : ''"
    >
      <div :class="!isFullPage ? 'mx-auto w-full max-w-7xl' : ''">
        <router-view v-slot="{ Component }">
          <component
            :is="Component"
            :key="`${activeProjectId}:${$route.fullPath}`"
            :default-environment-id="activeProject?.default_environment_id"
          />
        </router-view>
      </div>
    </main>
  </div>
</template>
