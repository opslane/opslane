import type { Router } from 'vue-router';
import { getMe, listProjects, markAuthed } from './api';

export async function completePostAuth(router: Pick<Router, 'push'>): Promise<void> {
	const me = await getMe();

  const returnPath = sessionStorage.getItem('opslane_post_auth_path');
  if (returnPath) {
    markAuthed();
    sessionStorage.removeItem('opslane_post_auth_path');
    await router.push(returnPath);
    return;
  }

  const projects = await listProjects();
	if (projects.length > 0) {
		localStorage.setItem('opslane_project_id', projects[0].id);
		localStorage.setItem('opslane_project_name', projects[0].name);
	}
	if (me.onboarding_complete) {
		localStorage.setItem('opslane_onboarding_complete', '1');
	} else {
		localStorage.removeItem('opslane_onboarding_complete');
	}
	markAuthed();
	await router.push(me.onboarding_complete ? '/' : '/setup');
}
