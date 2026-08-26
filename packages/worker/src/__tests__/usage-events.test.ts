import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';
import { emitUsageEvent, incidentUrlFor, sanitizeValue } from '../usage-events.js';

describe('sanitizeValue', () => {
  it('flattens newlines and escapes mrkdwn', () => {
    expect(sanitizeValue('a\r\nb\nc')).toBe('a b c');
    expect(sanitizeValue('<!channel> & <x|y>')).toBe('&lt;!channel&gt; &amp; &lt;x|y&gt;');
  });
  it('truncates without splitting surrogate pairs', () => {
    const out = sanitizeValue('😀'.repeat(400));
    expect([...out].length).toBe(301);
    expect(out.endsWith('…')).toBe(true);
    expect(out.includes('�')).toBe(false);
  });
});

describe('incidentUrlFor', () => {
  afterEach(() => delete process.env['DASHBOARD_URL']);
  it('builds the dashboard incident URL only for a configured http(s) base', () => {
    expect(incidentUrlFor('g', 'p')).toBe('');
    process.env['DASHBOARD_URL'] = 'https://app.example/';
    expect(incidentUrlFor('g/1', 'p 1')).toBe('https://app.example/incidents/g%2F1?project_id=p%201');
  });
});

describe('emitUsageEvent', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env['USAGE_EVENTS_SLACK_WEBHOOK'];
  });
  it('is a no-op when the env var is unset', () => {
    emitUsageEvent('fix_pr_opened', { project: 'p' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('POSTs a sanitized payload when configured', async () => {
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = 'https://hooks.example/T/B/x';
    emitUsageEvent('needs_human_created', { title: '<a>\nb' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.example/T/B/x');
    const body = JSON.parse((init as RequestInit).body as string) as { text: string };
    expect(body.text).toContain('*needs_human_created*');
    expect(body.text).toContain('&lt;a&gt; b');
    expect(body.text).not.toContain('<a>');
  });
  it('never throws for asynchronous or synchronous fetch failures', async () => {
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = 'https://hooks.example/T/B/x';
    fetchMock.mockRejectedValueOnce(new Error('secret URL'));
    expect(() => emitUsageEvent('fix_pr_opened', {})).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fetchMock.mockImplementationOnce(() => { throw new Error('sync secret URL'); });
    expect(() => emitUsageEvent('fix_pr_opened', {})).not.toThrow();
  });
  it('never logs the webhook URL when delivery fails', async () => {
    const secret = 'https://hooks.example/T/B/SECRETPATH';
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = secret;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(new Error(`request failed for ${secret}`));
    emitUsageEvent('fix_pr_opened', {});
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRETPATH');
  });
  it('caps text at 8000 UTF-8 bytes', async () => {
    process.env['USAGE_EVENTS_SLACK_WEBHOOK'] = 'https://hooks.example/T/B/x';
    const props: Record<string, string> = {};
    for (let i = 0; i < 60; i++) props[`k${String(i).padStart(2, '0')}`] = 'é'.repeat(400);
    emitUsageEvent('digest_delivered', props);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as { text: string };
    expect(new TextEncoder().encode(body.text).length).toBeLessThanOrEqual(8000);
    expect(body.text.startsWith('*digest_delivered*')).toBe(true);
    expect(body.text.includes('�')).toBe(false);
  });
});
