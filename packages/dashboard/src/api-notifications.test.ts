// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNotificationDestination,
  deleteNotificationDestination,
  listNotificationDestinations,
  testNotificationDestination,
  updateNotificationDestination,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown): object {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

describe('notification destinations API', () => {
  it('lists destinations for a project', async () => {
    const result = { can_manage: true, destinations: [] };
    const fetchMock = vi.fn().mockResolvedValue(response(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listNotificationDestinations('project-1')).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/notification-destinations',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('creates a Slack destination', async () => {
    const destination = {
      id: 'destination-1',
      type: 'slack' as const,
      name: 'Production alerts',
      config_fingerprint: 'hooks.slack.com/…/****part',
      event_types: ['issue.created'],
      enabled: true,
      created_at: '2026-07-19T00:00:00Z',
      last_delivery: null,
      recent_failures: 0,
    };
    const fetchMock = vi.fn().mockResolvedValue(response(destination));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createNotificationDestination('project-1', {
      name: 'Production alerts',
      webhook_url: 'https://hooks.slack.com/services/T/B/secret',
    })).resolves.toEqual(destination);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/notification-destinations',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Production alerts',
          webhook_url: 'https://hooks.slack.com/services/T/B/secret',
        }),
      }),
    );
  });

  it('patches a destination', async () => {
    const result = { id: 'destination-1', enabled: false };
    const fetchMock = vi.fn().mockResolvedValue(response(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateNotificationDestination(
      'project-1',
      'destination-1',
      { enabled: false },
    )).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/notification-destinations/destination-1',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it('patches the event types delivered to a destination', async () => {
    const result = { id: 'destination-1', event_types: ['digest.daily'] };
    const fetchMock = vi.fn().mockResolvedValue(response(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateNotificationDestination(
      'project-1',
      'destination-1',
      { event_types: ['digest.daily'] },
    )).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/notification-destinations/destination-1',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_types: ['digest.daily'] }),
      }),
    );
  });

  it('deletes a destination', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteNotificationDestination(
      'project-1',
      'destination-1',
    )).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/notification-destinations/destination-1',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    );
  });

  it('tests a destination and parses its classification', async () => {
    const result = { ok: true, classification: 'delivered', status_code: 200 };
    const fetchMock = vi.fn().mockResolvedValue(response(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(testNotificationDestination(
      'project-1',
      'destination-1',
    )).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/notification-destinations/destination-1/test',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
  });

  it('requests a daily digest preview', async () => {
    const result = { ok: true, classification: 'delivered', status_code: 200 };
    const fetchMock = vi.fn().mockResolvedValue(response(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(testNotificationDestination(
      'project-1',
      'destination-1',
      { eventType: 'digest.daily' },
    )).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/project-1/notification-destinations/destination-1/test',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'digest.daily' }),
      }),
    );
  });
});
