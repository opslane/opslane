/**
 * Read one agent run log from object storage.
 *
 *   pnpm --filter @opslane/worker exec tsx scripts/agent-runs.ts show agent-runs/<project>/<yyyy-mm-dd>/<run>/ [--full]
 *
 * Needs MINIO_* or REPLAY_STORE_* credentials for the bucket; no database access.
 */
import { parseInputBundle } from '@opslane/agent-runs';
import { fetchObject, getMinIOConfig } from '../src/minio-client.js';
import { formatRunLog, parseTranscript } from '../src/run-logs/format.js';

async function main(): Promise<void> {
  const [command, rawPrefix, ...flags] = process.argv.slice(2);
  if (command !== 'show' || !rawPrefix || flags.some((flag) => flag !== '--full')) {
    console.error('usage: agent-runs.ts show <object_prefix> [--full]');
    process.exit(2);
  }
  const config = getMinIOConfig();
  if (!config) {
    console.error('Object storage is not configured (set MINIO_* or REPLAY_STORE_*).');
    process.exit(2);
  }
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
  const bundle = parseInputBundle(JSON.parse((await fetchObject(`${prefix}input.json`, config)).toString('utf8')));
  let transcript: string | null = null;
  try {
    transcript = (await fetchObject(`${prefix}transcript.jsonl`, config)).toString('utf8');
  } catch (error: unknown) {
    if (!(error instanceof Error && ['NoSuchKey', 'NotFound'].includes(error.name))) throw error;
  }
  const events = transcript === null ? null : parseTranscript(transcript);
  console.log(formatRunLog(bundle, events, { full: flags.includes('--full') }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
