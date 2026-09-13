// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { router as appRouter, routes } from './router';

function testRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

describe('pre-rename detail links', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('redirects /incidents/:id to /issues/:id', async () => {
    const router = testRouter();
    await router.push('/incidents/abc');
    expect(router.currentRoute.value.name).toBe('incident');
    expect(router.currentRoute.value.path).toBe('/issues/abc');
    expect(router.currentRoute.value.params['id']).toBe('abc');
  });

  it('preserves the project_id query across the redirect', async () => {
    const router = testRouter();
    await router.push('/incidents/abc?project_id=proj-42');
    expect(router.currentRoute.value.fullPath).toBe('/issues/abc?project_id=proj-42');
    expect(router.currentRoute.value.query['project_id']).toBe('proj-42');
  });

  it('routes / to the issues list', async () => {
    const router = testRouter();
    await router.push('/');
    expect(router.currentRoute.value.name).toBe('issues');
  });
});

describe('onboarding guard', () => {
	it('requires both a selected project and the completion cache', async () => {
		localStorage.setItem('opslane_authed', '1');
		localStorage.setItem('opslane_project_id', 'project-1');
		localStorage.removeItem('opslane_onboarding_complete');

		await appRouter.push('/');
		expect(appRouter.currentRoute.value.name).toBe('setup');

		localStorage.setItem('opslane_onboarding_complete', '1');
		await appRouter.push('/');
		expect(appRouter.currentRoute.value.name).toBe('issues');

		localStorage.clear();
	});
});

describe('GitHub install page', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    // The app router is shared; start each test from another route so the push is a real navigation.
    await appRouter.push('/login');
    sessionStorage.clear();
  });

  it('parks /github/install for after sign-in', async () => {
    await appRouter.push('/github/install');
    expect(appRouter.currentRoute.value.name).toBe('login');
    expect(sessionStorage.getItem('opslane_post_auth_path')).toBe('/github/install');
  });

  it('keeps a signed-in user who has not finished onboarding on /github/install', async () => {
    localStorage.setItem('opslane_authed', '1');
    await appRouter.push('/github/install');
    expect(appRouter.currentRoute.value.name).toBe('github-install');
  });
});

describe('digest action login', () => {
  it('preserves the project and signed intent through login', async () => {
    localStorage.clear(); sessionStorage.clear();
    await appRouter.push('/issues/i1?project_id=p1&fixIntent=signed');
    expect(appRouter.currentRoute.value.name).toBe('login');
    expect(sessionStorage.getItem('opslane_post_auth_path')).toBe('/issues/i1?project_id=p1&fixIntent=signed');
    sessionStorage.clear();
  });
});
