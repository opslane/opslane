import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { isAuthenticated } from './api';
import IssuesList from './views/IssuesList.vue';
import AuthCallback from './views/AuthCallback.vue';
import IncidentDetail from './views/IncidentDetail.vue';
import Login from './views/Login.vue';
import ResetPassword from './views/ResetPassword.vue';
import SetupWizard from './views/SetupWizard.vue';
import Settings from './views/Settings.vue';
import AccountsList from './views/AccountsList.vue';
import AccountDetail from './views/AccountDetail.vue';
import AcceptInvitation from './views/AcceptInvitation.vue';
import { routeNeedsProject } from './route-project';

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: Login, meta: { public: true } },
  { path: '/reset-password', name: 'reset-password', component: ResetPassword, meta: { public: true } },
  { path: '/auth/complete', name: 'auth-complete', component: AuthCallback, meta: { public: true } },
  { path: '/invite/accept', name: 'invite-accept', component: AcceptInvitation },
  { path: '/setup', name: 'setup', component: SetupWizard },
  { path: '/', name: 'issues', component: IssuesList },
  { path: '/issues/:id', name: 'incident', component: IncidentDetail },
  // Preserve pre-rename bookmarks. Vue Router carries the query forward when
  // this function redirect only replaces the route name and params.
  { path: '/incidents/:id', redirect: (to) => ({ name: 'incident', params: to.params }) },
  { path: '/accounts', name: 'accounts', component: AccountsList },
  { path: '/accounts/:accountId', name: 'account-detail', component: AccountDetail },
  { path: '/sessions', name: 'sessions', component: () => import('./views/SessionsList.vue') },
  { path: '/sessions/:sessionId', name: 'session-detail', component: () => import('./views/SessionDetail.vue') },
  { path: '/settings', name: 'settings', component: Settings },
  { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const authed = isAuthenticated();
  const publicRoutes = ['login', 'auth-complete'];

  if (!to.meta.public && !authed) {
    if (to.name === 'invite-accept') {
      sessionStorage.setItem('opslane_post_auth_path', to.fullPath);
    }
    return { name: 'login' };
  }

  if (publicRoutes.includes(to.name as string) && authed) {
    // Don't redirect auth-complete — it needs to process cookies first
    if (to.name === 'auth-complete') return;
    return { name: 'issues' };
  }

	// The completion flag is a cache for the synchronous guard. SetupWizard
	// rechecks server state, so stale false costs one redirect and stale true is
	// corrected on the next login.
	if (authed && routeNeedsProject(to.name)) {
		const hasProject = !!localStorage.getItem('opslane_project_id');
		const onboarded = localStorage.getItem('opslane_onboarding_complete') === '1';
		if (!hasProject || !onboarded) {
			return { name: 'setup' };
    }
  }
});
