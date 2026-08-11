import http from 'node:http';

const port = Number(process.env.ANTHROPIC_STUB_PORT ?? 9191);
const mode = process.env.ANTHROPIC_STUB_MODE ?? 'filler';
const citationPath = process.env.ANTHROPIC_STUB_CITATION_PATH ?? 'src/App.vue';
let requestCount = 0;

function response(content, stopReason = 'tool_use') {
  return {
    id: `msg_stub_${requestCount}`,
    type: 'message',
    role: 'assistant',
    model: 'anthropic-stub',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 100,
      cache_creation_input_tokens: requestCount === 1 ? 1200 : 0,
      cache_read_input_tokens: requestCount > 1 ? 1200 : 0,
    },
  };
}

function toolUse(name, input) {
  return { type: 'tool_use', id: `tool_stub_${requestCount}`, name, input };
}

function terminalInput(name) {
  if (name === 'classify_friction') {
    return {
      codeCause: true,
      confidence: 'high',
      reason: mode === 'filler' ? 'placeholder while I continue reading' : 'The save control has no click handler.',
      remediation: 'Wire the save action.',
      evidence: [{ path: citationPath, detail: 'the control has no handler', symptomLink: 'clicks do nothing' }],
      agent_task_brief: '## Symptom\nSave does nothing.\n## Change\nWire the click handler.',
    };
  }
  return {
    best_supported: mode === 'filler' ? 'placeholder while I continue reading' : 'The render path dereferences a nullable value.',
    evidence_check: `Read ${citationPath}.`,
    candidates_considered: [{ statement: 'A nullable value reaches render', kind: 'local_code' }],
    rejected: [],
    evidence_strength: 'conclusive',
    cause_kind: 'local_code',
    cause_locations: [{ path: citationPath, line: 1 }],
    reasoning: 'The cited render path lacks a guard.',
    why_chain: ['Value is null', 'Render dereferences it', 'The page throws'],
    reproduction_steps: ['Open the affected page'],
    evidence: [{ path: citationPath, detail: 'the render dereferences the value', symptomLink: 'the page throws' }],
    agent_task_brief: '## Symptom\nThe page throws.\n## Change\nGuard the nullable render value.',
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: requestCount }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requestCount++;
  const terminal = body.tools?.find((tool) => tool.name === 'classify_friction' || tool.name === 'submit_diagnosis');
  const hasToolResult = body.messages?.some((message) =>
    Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result'));

  let message;
  if (mode === 'no_evidence') {
    message = response([toolUse('list_files', { path: '.', recursive: true })]);
  } else if (!hasToolResult && !body.tool_choice) {
    message = response([toolUse('read_file', { path: citationPath })]);
  } else {
    message = response([toolUse(terminal?.name ?? 'classify_friction', terminalInput(terminal?.name))]);
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(message));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`anthropic stub listening on http://127.0.0.1:${port}\n`);
});
