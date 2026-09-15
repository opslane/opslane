import { describe, expect, it } from 'vitest';
import {
  buildErrorEvidence,
  MAX_BREADCRUMBS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_STACK_LINES,
  TRUNCATED,
  type ErrorEventText,
} from '../evidence/error-evidence.js';
import { MASKED_EMAIL, MASKED_NUMBER, MASKED_TOKEN } from '../evidence/mask.js';

function input(over: Partial<ErrorEventText> = {}): ErrorEventText {
  return {
    errorType: 'Error',
    errorMessage: 'Error deleting Assets',
    stackTraceRaw: 'Error: Error deleting Assets\n    at deleteAssets (https://app.example.com/assets/index.js:1:234567)',
    breadcrumbs: [],
    pageUrl: 'https://app.example.com/assets?filter=mine',
    ...over,
  };
}

describe('buildErrorEvidence', () => {
  it('carries type, message, stack and page URL', () => {
    const evidence = buildErrorEvidence(input());
    expect(evidence).toEqual({
      type: 'Error',
      message: 'Error deleting Assets',
      stack: [
        'Error: Error deleting Assets',
        '    at deleteAssets (https://app.example.com/assets/index.js:1:234567)',
      ],
      stackLinesOmitted: 0,
      breadcrumbs: [],
      breadcrumbsOmitted: 0,
      pageUrl: 'https://app.example.com/assets',
    });
  });

  it('bounds the message to 500 characters, marker included', () => {
    const evidence = buildErrorEvidence(input({ errorMessage: 'word '.repeat(1_000) }));
    expect(evidence.message).toHaveLength(MAX_ERROR_MESSAGE_CHARS);
    expect(evidence.message.endsWith(TRUNCATED)).toBe(true);
  });

  it('masks before truncating so a cut cannot expose part of an email', () => {
    const message = `${'x'.repeat(MAX_ERROR_MESSAGE_CHARS - 10)} jane.doe@acme.com`;
    const evidence = buildErrorEvidence(input({ errorMessage: message }));
    expect(evidence.message).not.toContain('jane');
    expect(evidence.message).not.toContain('acme');
  });

  it('never shows a value severed by the pre-bound slice', () => {
    const preBound = 8_192;
    const message = `${'1'.repeat(preBound - 14)} jane.doe@acme.com trailing words`;
    const evidence = buildErrorEvidence(input({ errorMessage: message }));
    expect(evidence.message).toBe(`${MASKED_NUMBER} ${TRUNCATED}`);
  });

  it('masks a JSON secret whose closing quote the pre-bound slice removed', () => {
    const message = `{"token":"top secret ${'word '.repeat(2_000)}"}`;
    const evidence = buildErrorEvidence(input({ errorMessage: message }));
    expect(evidence.message).toBe(`{"token":"${MASKED_TOKEN}"${TRUNCATED}`);
  });

  it('masks breadcrumb data structurally, including JSON held in a string', () => {
    const evidence = buildErrorEvidence(input({
      breadcrumbs: [{
        type: 'fetch', timestamp: '2026-09-14T10:00:00.000Z', category: 'http', message: 'POST /api/login',
        data: { status: 409, token: 'abc', body: '{"password":"hunter2"}' },
      }],
    }));
    expect(evidence.breadcrumbs[0]?.data).toBe(JSON.stringify({
      status: 409, token: MASKED_TOKEN, body: `{"password":"${MASKED_TOKEN}"}`,
    }));
  });

  it('keeps the first 30 non-blank stack lines and counts the rest', () => {
    const stack = Array.from({ length: 45 }, (_, i) => `    at f${i} (app.js:${i + 1}:1)`).join('\n\n');
    const evidence = buildErrorEvidence(input({ stackTraceRaw: stack }));
    expect(evidence.stack).toHaveLength(MAX_STACK_LINES);
    expect(evidence.stack[0]).toBe('    at f0 (app.js:1:1)');
    expect(evidence.stackLinesOmitted).toBe(15);
  });

  it('keeps the last 20 breadcrumbs, masked and bounded', () => {
    const crumbs = Array.from({ length: 25 }, (_, i) => ({
      type: 'fetch',
      timestamp: `2026-09-14T10:00:${String(i).padStart(2, '0')}.000Z`,
      category: 'http',
      message: `POST /api/users/jane@acme.com/${10_000_000 + i}`,
      data: { status: 500, url: '/api/assets' },
      level: 'error',
    }));
    const evidence = buildErrorEvidence(input({ breadcrumbs: crumbs }));
    expect(evidence.breadcrumbs).toHaveLength(MAX_BREADCRUMBS);
    expect(evidence.breadcrumbsOmitted).toBe(5);
    expect(evidence.breadcrumbs[0]).toEqual({
      timestamp: '2026-09-14T10:00:05.000Z',
      type: 'fetch',
      category: 'http',
      level: 'error',
      message: `POST /api/users/${MASKED_EMAIL}/${MASKED_NUMBER}`,
      data: '{"status":500,"url":"/api/assets"}',
    });
  });

  it('keeps a numeric or ISO timestamp and drops anything else', () => {
    const evidence = buildErrorEvidence(input({
      breadcrumbs: [
        { type: 'ui', timestamp: 1726308000000, category: 'click', message: 'button' },
        { type: 'ui', timestamp: 'jane@acme.com', category: 'click', message: 'button' },
      ],
    }));
    expect(evidence.breadcrumbs[0]).toMatchObject({ timestamp: '1726308000000', level: null, data: null });
    expect(evidence.breadcrumbs[1]?.timestamp).toBe('');
  });

  it('treats malformed breadcrumbs as none', () => {
    expect(buildErrorEvidence(input({ breadcrumbs: { not: 'an array' } })).breadcrumbs).toEqual([]);
    expect(buildErrorEvidence(input({ breadcrumbs: ['string', 3, null] })).breadcrumbs).toEqual([]);
  });

  it('masks the error type and every stack line', () => {
    const evidence = buildErrorEvidence(input({
      errorType: 'Error 12345678',
      stackTraceRaw: 'Error: no user jane@acme.com\n    at x (app.js:1:2)',
    }));
    expect(evidence.type).toBe(`Error ${MASKED_NUMBER}`);
    expect(evidence.stack[0]).toBe(`Error: no user ${MASKED_EMAIL}`);
  });

  it('keeps origin and path of a page URL with a very long query string', () => {
    const evidence = buildErrorEvidence(input({
      pageUrl: `https://app.example.com/oauth/callback?state=${'s'.repeat(5_000)}`,
    }));
    expect(evidence.pageUrl).toBe('https://app.example.com/oauth/callback');
  });

  it('keeps the head of a long message that has no whitespace', () => {
    const evidence = buildErrorEvidence(input({ errorMessage: `Error:${'{"field":"value"},'.repeat(200)}` }));
    expect(evidence.message.startsWith('Error:{"field":"value"}')).toBe(true);
    expect(evidence.message.endsWith(TRUNCATED)).toBe(true);
  });

  it('counts a very large stack without keeping more than 30 bounded lines', () => {
    const stack = Array.from({ length: 100_000 }, (_, i) => `    at f${i} (app.js:1:1)`).join('\n');
    const evidence = buildErrorEvidence(input({ stackTraceRaw: `${'x'.repeat(20_000)}\n${stack}` }));
    expect(evidence.stack).toHaveLength(MAX_STACK_LINES);
    expect(evidence.stack[0]!.length).toBeLessThanOrEqual(300);
    expect(evidence.stack[0]!.endsWith(TRUNCATED)).toBe(true);
    expect(evidence.stackLinesOmitted).toBe(100_001 - MAX_STACK_LINES);
  });

  it('keeps a null page URL null', () => {
    expect(buildErrorEvidence(input({ pageUrl: null })).pageUrl).toBeNull();
  });
});
