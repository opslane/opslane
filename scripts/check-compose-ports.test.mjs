// Tests for check-compose-ports.mjs. Each case regresses one property of the
// host-port contract and asserts the checker rejects it — a checker that
// cannot fail is not a gate.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkComposePorts } from './check-compose-ports.mjs';

const GOOD = `services:
  minio:
    image: minio/minio
    ports:
      - "\${OPSLANE_INFRA_BIND_ADDR:-127.0.0.1}:\${OPSLANE_MINIO_HOST_PORT:-9012}:9000"
  minio-setup:
    image: minio/mc
    entrypoint: ["/minio-setup.sh"]
  ingestion:
    image: busybox
    ports:
      - "\${INGESTION_PORT:-8082}:8080"
    environment:
      REPLAY_STORE_PUBLIC_ENDPOINT: \${REPLAY_STORE_PUBLIC_ENDPOINT:-http://localhost:\${OPSLANE_MINIO_HOST_PORT:-9012}}
    extra_hosts:
      - "host.docker.internal:host-gateway"
`;

function runOn(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'compose-ports-'));
  try {
    writeFileSync(join(dir, 'docker-compose.yml'), yaml);
    return checkComposePorts({ cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('accepts a compliant compose file', () => {
  assert.deepEqual(runOn(GOOD), []);
});

test('ignores extra_hosts entries that look like port mappings', () => {
  // Regression: the first draft matched "host.docker.internal:host-gateway"
  // as a hardcoded published port.
  assert.equal(
    runOn(GOOD).filter((p) => p.includes('host-gateway')).length,
    0,
  );
});

test('rejects infrastructure published on all interfaces', () => {
  const bad = GOOD.replace('${OPSLANE_INFRA_BIND_ADDR:-127.0.0.1}:', '');
  assert.match(runOn(bad).join('\n'), /must bind 127\.0\.0\.1/);
});

test('rejects loopback-binding the user-facing ingestion port', () => {
  const bad = GOOD.replace('"${INGESTION_PORT:-8082}:8080"', '"127.0.0.1:${INGESTION_PORT:-8082}:8080"');
  assert.match(runOn(bad).join('\n'), /must stay reachable off-host/);
});

test('rejects a re-hardcoded published port', () => {
  const bad = GOOD.replace('${OPSLANE_MINIO_HOST_PORT:-9012}:9000', '9012:9000');
  assert.match(runOn(bad).join("\n"), /hardcodes the host port 9012/);
});

test('rejects a port variable that breaks the naming convention', () => {
  const bad = GOOD.replaceAll('OPSLANE_MINIO_HOST_PORT', 'MINIO_PORT');
  assert.match(runOn(bad).join('\n'), /port variables must match/);
});

test('rejects ${VAR-default}, which publishes an ephemeral port when empty', () => {
  const bad = GOOD.replace('${OPSLANE_MINIO_HOST_PORT:-9012}:9000', '${OPSLANE_MINIO_HOST_PORT-9012}:9000');
  const problems = runOn(bad).join('\n');
  assert.match(problems, /instead of \$\{OPSLANE_MINIO_HOST_PORT:-\.\.\.\}/);
});

test('rejects a replay endpoint that stops following the MinIO host port', () => {
  const bad = GOOD.replace(
    '${REPLAY_STORE_PUBLIC_ENDPOINT:-http://localhost:${OPSLANE_MINIO_HOST_PORT:-9012}}',
    'http://localhost:9012',
  );
  assert.match(runOn(bad).join('\n'), /upload replay chunks to the wrong stack/);
});

test('rejects an inline entrypoint truncated by a nested quote', () => {
  // The exact defect this checker was written for: valid YAML, valid compose
  // schema, invalid shell. `docker compose config --quiet` accepts it.
  const bad = GOOD.replace(
    '    entrypoint: ["/minio-setup.sh"]',
    '    entrypoint: >\n      sh -c "echo \'inspect -f "{{json .Networks}}" x\'"',
  );
  assert.match(runOn(bad).join('\n'), /does not parse as shell/);
});
