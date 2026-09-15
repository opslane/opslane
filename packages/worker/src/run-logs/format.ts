import { parseTranscriptEvent, type InputBundle, type TranscriptEvent } from '@opslane/agent-runs';

/** Parse and validate every transcript line; a malformed line throws with its line number. */
export function parseTranscript(jsonl: string): TranscriptEvent[] {
  return jsonl.split('\n').flatMap((line, index) => {
    if (line.trim() === '') return [];
    try {
      return [parseTranscriptEvent(JSON.parse(line))];
    } catch (error: unknown) {
      throw new Error(`transcript line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** Show control characters from stored text as escapes, so a run log cannot drive the operator's terminal. */
function terminalSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function clip(text: string, full: boolean, max: number): string {
  return full || text.length <= max ? text : `${text.slice(0, max)}\n  [truncated for display: ${text.length} chars, use --full]`;
}

export function formatRunLog(
  bundle: InputBundle,
  events: TranscriptEvent[] | null,
  options: { full?: boolean; maxToolChars?: number } = {},
): string {
  const full = options.full === true;
  const max = options.maxToolChars ?? 2_000;
  const lines: string[] = [];
  const repo = bundle.repository ? `${bundle.repository.fullName}@${bundle.repository.commitSha}` : 'no repository';
  lines.push(`${bundle.phase}  ${bundle.entryPoint}`);
  lines.push(`run ${bundle.runId}  build ${bundle.workerBuildSha}  ${repo}`);
  lines.push(`settings ${JSON.stringify(bundle.settings)}`);
  lines.push('', '== first request ==', clip(typeof bundle.request === 'string' ? bundle.request : JSON.stringify(bundle.request, null, 2), full, max * 4));
  if (bundle.images.length > 0) lines.push(`images ${JSON.stringify(bundle.images)}`);
  lines.push('', '== transcript ==');
  if (events === null) {
    lines.push('No transcript: the run is unfinished or its transcript could not be written.');
    return terminalSafe(lines.join('\n'));
  }
  let turn = 0;
  for (const event of events) {
    switch (event.type) {
      case 'response':
        turn++;
        lines.push(`-- turn ${turn} (${event.model}, stop ${event.stopReason ?? 'none'}, in ${event.usage.input} out ${event.usage.output})`);
        for (const block of event.content) {
          if (block.type === 'text') lines.push(clip(block.text, full, max));
          else if (block.type === 'tool_use') lines.push(`  → ${block.name} ${JSON.stringify(block.input)}`);
          else lines.push(block.redacted ? '  [thinking redacted]' : `  [thinking] ${clip(block.text, full, max)}`);
        }
        break;
      case 'tool_call':
        lines.push(`  → ${event.name} ${JSON.stringify(event.input)}`);
        break;
      case 'tool_result':
        lines.push(`  ← ${event.name || 'tool'}${event.isError ? ' ERROR' : ''}: ${clip(event.output, full, max)}`);
        break;
      case 'request':
        lines.push(`-- re-ask: ${clip(JSON.stringify(event.request), full, max)}`);
        break;
      case 'validator_rejection':
        lines.push(`  REJECTED: ${event.message}${event.rule ? ` (${event.rule})` : ''}`);
        lines.push(`  payload: ${clip(JSON.stringify(event.payload), full, max)}`);
        break;
      case 'sdk_message':
        lines.push(`  [sdk] ${clip(JSON.stringify(event.message), full, max)}`);
        break;
      case 'error':
        lines.push(`  ERROR ${event.errorClass}: ${event.message}`);
        lines.push(...event.stack.map((frame) => `    ${frame}`));
        break;
      case 'stop':
        lines.push(`STOP ${event.stop}${event.transcriptTruncated ? ` (transcript dropped ${event.transcriptTruncated.droppedEvents} events)` : ''}`);
        break;
    }
  }
  return terminalSafe(lines.join('\n'));
}
