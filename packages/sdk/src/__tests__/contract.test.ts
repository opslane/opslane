// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import * as http from 'node:http';
import type { ErrorEventPayload } from '@opslane/shared';
import { TEST_PK } from './test-keys';

let server: http.Server;
let serverPort: number;
let receivedRequests: Array<{ method: string; url: string; headers: Record<string, string>; body: string }>;

beforeAll(async () => {
  receivedRequests = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      receivedRequests.push({
        method: req.method || '',
        url: req.url || '',
        headers: req.headers as Record<string, string>,
        body,
      });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"status":"accepted"}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      serverPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  receivedRequests = [];
});

describe('SDK contract', () => {
  it('captures error and sends valid payload with X-API-Key', async () => {
    // Dynamic import to reset module state between tests
    const sdk = await import('../index.js');

    sdk.init({
      endpoint: `http://localhost:${serverPort}`,
      apiKey: TEST_PK,
      flushInterval: 100,
      maxBatchSize: 1,
      debug: true,
    });

    // Simulate sending an error event via the transport
    const { enqueueEvent } = await import('../transport.js');
    const testPayload: ErrorEventPayload = {
      timestamp: new Date().toISOString(),
      error: {
        type: 'TypeError',
        message: "Cannot read properties of null (reading 'name')",
        stack: 'TypeError: Cannot read properties of null\n    at UserCard.vue:8:20',
      },
      breadcrumbs: [{
        type: 'navigation',
        timestamp: new Date().toISOString(),
        category: 'navigation',
        message: 'http://localhost/test',
      }],
      context: { url: 'http://localhost/test', user_agent: 'vitest' },
      sdk_version: '0.0.1',
    };

    enqueueEvent(testPayload);

    // Wait for flush
    await new Promise(r => setTimeout(r, 500));

    expect(receivedRequests.length).toBeGreaterThanOrEqual(1);
    const req = receivedRequests.find((request) => request.url === '/api/v1/events');
    expect(req).toBeDefined();
    if (!req) throw new Error('event request not received');
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/events');
    expect(req.headers['x-api-key']).toBe(TEST_PK);
    expect(req.headers['content-type']).toBe('application/json');

    const payload = JSON.parse(req.body);
    // Payload is an array (batched)
    const events = Array.isArray(payload) ? payload : [payload];
    expect(events[0].error.type).toBe('TypeError');
    expect(events[0].breadcrumbs.length).toBeGreaterThanOrEqual(1);

    sdk.destroy();
  });
});
