import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentClickId,
  installInteractionTelemetry,
  setTelemetrySink,
  type TelemetryEvent,
  uninstallInteractionTelemetry,
} from '../telemetry';
import { loadConfig, resetConfig } from '../config';
import { TEST_PK } from './test-keys';

describe('interaction telemetry', () => {
  let events: TelemetryEvent[];

  beforeEach(() => {
    events = [];
    resetConfig();
    loadConfig({ apiKey: TEST_PK, endpoint: 'https://ingest.example.com' });
    setTelemetrySink((event) => events.push(event));
    document.body.innerHTML = '';
    uninstallInteractionTelemetry();
    installInteractionTelemetry();
  });

  it('emits a click event with selector and cursor', () => {
    document.body.innerHTML = '<button data-testid="buy">Buy</button>';
    document.querySelector('button')?.click();
    expect(events.find((event) => event.kind === 'click')).toMatchObject({
      kind: 'click', selector: '[data-testid="buy"]', cursor: expect.any(String),
    });
  });

  it('sets click context before app handlers run', () => {
    document.body.innerHTML = '<button id="b">Buy</button>';
    let seen: string | null = null;
    document.querySelector('button')?.addEventListener('click', () => { seen = currentClickId(); });
    document.querySelector('button')?.click();
    expect(seen).toBeTruthy();
    expect(seen).toBe((events.find((event) => event.kind === 'click') as { clickId: string }).clickId);
  });

  it('has no click context outside a click', () => {
    expect(currentClickId()).toBeNull();
  });

  it('emits form_submit with a selector', () => {
    document.body.innerHTML = '<form data-testid="signup"><input name="e"/></form>';
    const form = document.querySelector('form')!;
    form.addEventListener('submit', (event) => event.preventDefault());
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(events.find((event) => event.kind === 'form_submit')).toMatchObject({
      kind: 'form_submit', selector: '[data-testid="signup"]',
    });
  });

  it('contains throwing or absent sinks', () => {
    setTelemetrySink(null);
    document.body.innerHTML = '<button>x</button>';
    expect(() => document.querySelector('button')?.click()).not.toThrow();
    setTelemetrySink(() => { throw new Error('sink exploded'); });
    expect(() => document.querySelector('button')?.click()).not.toThrow();
  });

  it('uninstall stops emission', () => {
    uninstallInteractionTelemetry();
    document.body.innerHTML = '<button>x</button>';
    document.querySelector('button')?.click();
    expect(events).toHaveLength(0);
  });

  it('emits request_start from XHR send, not open, and filters SDK traffic', () => {
    const { patchXHR, unpatchXHR } = requireNetwork();
    patchXHR();
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://api.example.com/cart');
      expect(events.find((event) => event.kind === 'request_start')).toBeUndefined();
      try { xhr.send('{}'); } catch { /* jsdom may reject the network request */ }
      expect(events.find((event) => event.kind === 'request_start')).toMatchObject({
        kind: 'request_start', method: 'POST', url: 'https://api.example.com/cart',
      });

      events.length = 0;
      const own = new XMLHttpRequest();
      own.open('POST', 'https://ingest.example.com/api/v1/events');
      try { own.send('{}'); } catch { /* noop */ }
      expect(events.find((event) => event.kind === 'request_start')).toBeUndefined();
    } finally {
      unpatchXHR();
    }
  });
});

function requireNetwork(): typeof import('../network') {
  // Static import would be equivalent, but this helper keeps the XHR patch
  // lifecycle visually local to the one test that owns it.
  return networkModule;
}

import * as networkModule from '../network';
