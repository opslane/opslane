export const RUN_LOG_SCHEMA_VERSION = 1;

export const RUN_STOPS = [
  'completed', 'terminal_tool', 'invalid_output', 'turns_exhausted', 'budget', 'truncated',
  'no_tool_call', 'no_evidence', 'api_error', 'machine_lost', 'aborted', 'threw',
] as const;
export type RunStop = typeof RUN_STOPS[number];

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Thinking tokens, when the provider reports them. Included in `output`. */
  thinking?: number;
}

export interface RepositoryRef {
  provider: 'github';
  fullName: string;
  commitSha: string;
}

export type ImageRef =
  | { kind: 'object'; objectKey: string; sha256: string }
  | { kind: 'capture'; sessionId: string; offsetMs: number; pair: string; captureSettings: Record<string, unknown>; sha256: string };

export interface InputBundle {
  schemaVersion: number;
  runId: string;
  phase: string;
  entryPoint: string;
  workerBuildSha: string;
  repository: RepositoryRef | null;
  settings: Record<string, unknown>;
  structuredInput: unknown;
  request: unknown;
  images: ImageRef[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; text: string; redacted: boolean };

export type TranscriptEvent =
  | { type: 'response'; at: string; model: string; content: ContentBlock[]; stopReason: string | null; usage: RunUsage; requestId?: string; messageId?: string }
  | { type: 'request'; at: string; request: unknown }
  | { type: 'tool_call'; at: string; id: string; name: string; input: unknown }
  | { type: 'tool_result'; at: string; id: string; name: string; output: string; isError: boolean }
  | { type: 'validator_rejection'; at: string; message: string; payload: unknown; rule?: string }
  | { type: 'sdk_message'; at: string; message: unknown }
  | { type: 'error'; at: string; errorClass: string; message: string; stack: string[] }
  | { type: 'stop'; at: string; stop: RunStop; transcriptTruncated?: { droppedEvents: number } };

export interface StartedRow {
  runId: string;
  jobId: string;
  jobType: string;
  projectId: string;
  phase: string;
  entryPoint: string;
  attempts: number;
  leaseGeneration: string;
  errorGroupId: string | null;
  ticketId: string | null;
  episodeId: string | null;
  batchId: string | null;
  sessionId: string | null;
  commitSha: string | null;
  objectPrefix: string;
  models: string[];
  workerBuildSha: string;
  bundleWritten: boolean;
  bundleBytes: number;
  recordedAt: Date;
}

export interface FinishedRow {
  runId: string;
  stop: RunStop;
  errorClass: string | null;
  errorDetail: string | null;
  modelRequests: number;
  turns: number;
  usage: Record<string, RunUsage>;
  costUsd: number;
  transcriptWritten: boolean;
  transcriptBytes: number;
  finishedAt: Date;
}

type Obj = Record<string, unknown>;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

function obj(value: unknown, where: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Obj;
}

function onlyKeys(value: Obj, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where}: unknown field ${key}`);
  }
}

function str(value: Obj, key: string, where: string, allowEmpty = false): string {
  const field = value[key];
  if (typeof field !== 'string' || (!allowEmpty && field === '')) throw new Error(`${where} ${key} must be a string`);
  return field;
}

function num(value: Obj, key: string, where: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isFinite(field) || field < 0) throw new Error(`${where} ${key} must be a non-negative number`);
  return field;
}

function parseImage(value: unknown, index: number): ImageRef {
  const where = `image ${index}`;
  const image = obj(value, where);
  if (typeof image['sha256'] !== 'string' || !SHA256.test(image['sha256'])) throw new Error(`${where} sha256 must be 64 hex characters`);
  if (image['kind'] === 'object') {
    onlyKeys(image, ['kind', 'objectKey', 'sha256'], where);
    str(image, 'objectKey', where);
  } else if (image['kind'] === 'capture') {
    onlyKeys(image, ['kind', 'sessionId', 'offsetMs', 'pair', 'captureSettings', 'sha256'], where);
    str(image, 'sessionId', where);
    num(image, 'offsetMs', where);
    str(image, 'pair', where);
    obj(image['captureSettings'], `${where} captureSettings`);
  } else {
    throw new Error(`${where} kind must be object or capture`);
  }
  return image as unknown as ImageRef;
}

// An inline base64 image payload. Text that merely mentions the prefix, or a payload
// the scrubber already replaced with [image], is ordinary content.
const IMAGE_DATA_URL_PAYLOAD = /data:image\/[A-Za-z0-9.+-]{1,32};base64,\s*(?!\[image\])[A-Za-z0-9+/]/i;

/** Reject image byte representations, including those nested in request DTOs. */
function rejectImageBytes(value: unknown, ancestors = new Set<object>()): void {
  if (typeof value === 'string' && IMAGE_DATA_URL_PAYLOAD.test(value)) {
    throw new Error('image bytes must be replaced with references');
  }
  if (typeof value !== 'object' || value === null) return;
  if (ancestors.has(value)) throw new Error('run log payload must not be circular');
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error('binary image bytes must be replaced with references');
  }
  const fields = value as Obj;
  if ((fields['type'] === 'base64' && fields['data'] !== '[image]')
    || (fields['type'] === 'Buffer' && Array.isArray(fields['data']))
    || (typeof (fields['mediaType'] ?? fields['media_type']) === 'string'
      && String(fields['mediaType'] ?? fields['media_type']).startsWith('image/')
      && fields['base64'] !== undefined)) {
    throw new Error('image bytes must be replaced with references');
  }
  ancestors.add(value);
  for (const child of Object.values(value)) rejectImageBytes(child, ancestors);
  ancestors.delete(value);
}

/** Validate a bundle read back from storage. Throws with the first problem found. */
export function parseInputBundle(value: unknown): InputBundle {
  const bundle = obj(value, 'input bundle');
  onlyKeys(bundle, ['schemaVersion', 'runId', 'phase', 'entryPoint', 'workerBuildSha', 'repository', 'settings', 'structuredInput', 'request', 'images'], 'input bundle');
  if (bundle['schemaVersion'] !== RUN_LOG_SCHEMA_VERSION) {
    throw new Error(`unsupported input bundle schema version ${String(bundle['schemaVersion'])}`);
  }
  for (const key of ['runId', 'phase', 'entryPoint', 'workerBuildSha']) str(bundle, key, 'input bundle');
  if (bundle['repository'] !== null) {
    const repository = obj(bundle['repository'], 'input bundle repository');
    onlyKeys(repository, ['provider', 'fullName', 'commitSha'], 'input bundle repository');
    if (repository['provider'] !== 'github' || typeof repository['fullName'] !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository['fullName'])
      || typeof repository['commitSha'] !== 'string' || !COMMIT.test(repository['commitSha'])) {
      throw new Error('input bundle repository must be { provider: github, fullName: owner/name, commitSha }');
    }
  }
  obj(bundle['settings'], 'input bundle settings');
  if (bundle['structuredInput'] === undefined) throw new Error('input bundle structuredInput is missing');
  if (bundle['request'] === undefined) throw new Error('input bundle request is missing');
  if (!Array.isArray(bundle['images'])) throw new Error('input bundle images must be an array');
  bundle['images'].forEach(parseImage);
  rejectImageBytes(bundle);
  return bundle as unknown as InputBundle;
}

function parseContentBlock(value: unknown, where: string): void {
  const block = obj(value, where);
  if (block['type'] === 'text') {
    onlyKeys(block, ['type', 'text'], where);
    str(block, 'text', where, true);
  } else if (block['type'] === 'tool_use') {
    onlyKeys(block, ['type', 'id', 'name', 'input'], where);
    str(block, 'id', where, true);
    str(block, 'name', where, true);
    if (block['input'] === undefined) throw new Error(`${where} input is missing`);
  } else if (block['type'] === 'thinking') {
    onlyKeys(block, ['type', 'text', 'redacted'], where);
    str(block, 'text', where, true);
    if (typeof block['redacted'] !== 'boolean') throw new Error(`${where} redacted must be a boolean`);
  } else {
    throw new Error(`${where} type must be text, tool_use or thinking`);
  }
}

function parseUsage(value: unknown): void {
  const usage = obj(value, 'response usage');
  onlyKeys(usage, ['input', 'output', 'cacheRead', 'cacheWrite', 'thinking'], 'response usage');
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) num(usage, key, 'response usage');
  if (usage['thinking'] !== undefined) num(usage, 'thinking', 'response usage');
}

/** Validate one transcript line read back from storage. */
export function parseTranscriptEvent(value: unknown): TranscriptEvent {
  const event = obj(value, 'transcript event');
  str(event, 'at', 'transcript event');
  const where = `transcript ${String(event['type'])} event`;
  switch (event['type']) {
    case 'response': {
      onlyKeys(event, ['type', 'at', 'model', 'content', 'stopReason', 'usage', 'requestId', 'messageId'], where);
      str(event, 'model', where, true);
      if (!Array.isArray(event['content'])) throw new Error(`${where} content must be an array`);
      event['content'].forEach((raw, index) => parseContentBlock(raw, `${where} content ${index}`));
      if (event['requestId'] !== undefined) str(event, 'requestId', where);
      if (event['messageId'] !== undefined) str(event, 'messageId', where, true);
      if (event['stopReason'] !== null && typeof event['stopReason'] !== 'string') throw new Error(`${where} stopReason must be a string or null`);
      parseUsage(event['usage']);
      break;
    }
    case 'request':
      onlyKeys(event, ['type', 'at', 'request'], where);
      if (event['request'] === undefined) throw new Error(`${where} request is missing`);
      break;
    case 'tool_call':
      onlyKeys(event, ['type', 'at', 'id', 'name', 'input'], where);
      str(event, 'id', where, true);
      str(event, 'name', where, true);
      if (event['input'] === undefined) throw new Error(`${where} input is missing`);
      break;
    case 'tool_result':
      onlyKeys(event, ['type', 'at', 'id', 'name', 'output', 'isError'], where);
      str(event, 'id', where, true);
      str(event, 'name', where, true);
      str(event, 'output', where, true);
      if (typeof event['isError'] !== 'boolean') throw new Error(`${where} isError must be a boolean`);
      break;
    case 'validator_rejection':
      onlyKeys(event, ['type', 'at', 'message', 'payload', 'rule'], where);
      str(event, 'message', where, true);
      if (event['payload'] === undefined) throw new Error(`${where} payload is missing`);
      if (event['rule'] !== undefined) str(event, 'rule', where, true);
      break;
    case 'sdk_message':
      onlyKeys(event, ['type', 'at', 'message'], where);
      if (event['message'] === undefined) throw new Error(`${where} message is missing`);
      break;
    case 'error':
      onlyKeys(event, ['type', 'at', 'errorClass', 'message', 'stack'], where);
      str(event, 'errorClass', where, true);
      str(event, 'message', where, true);
      if (!Array.isArray(event['stack']) || !event['stack'].every((line) => typeof line === 'string')) throw new Error(`${where} stack must be an array of strings`);
      break;
    case 'stop':
      onlyKeys(event, ['type', 'at', 'stop', 'transcriptTruncated'], where);
      if (!(RUN_STOPS as readonly string[]).includes(String(event['stop']))) throw new Error(`${where} stop must be a known stop`);
      if (event['transcriptTruncated'] !== undefined) {
        const truncated = obj(event['transcriptTruncated'], `${where} transcriptTruncated`);
        onlyKeys(truncated, ['droppedEvents'], `${where} transcriptTruncated`);
        const dropped = num(truncated, 'droppedEvents', `${where} transcriptTruncated`);
        if (!Number.isInteger(dropped)) throw new Error(`${where} droppedEvents must be an integer`);
      }
      break;
    default:
      throw new Error(`transcript event type ${String(event['type'])} is unknown`);
  }
  rejectImageBytes(event);
  return event as unknown as TranscriptEvent;
}
