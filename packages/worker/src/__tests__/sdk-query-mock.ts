interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface FakeTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
}

interface FakeResponse {
  content: Array<Record<string, unknown>>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stop_reason?: string;
}

/**
 * Adapt the old Messages-API scripts in caller tests to the SDK transport.
 * SDK mechanics themselves are tested in harness/__tests__/sdk-agent.test.ts.
 */
export function fakeClaudeAgentSdk(messagesCreate: (request: Record<string, unknown>) => Promise<FakeResponse>) {
  return {
    tool: (
      name: string,
      description: string,
      inputSchema: unknown,
      handler: FakeTool['handler'],
    ): FakeTool => ({ name, description, inputSchema, handler }),
    createSdkMcpServer: (options: unknown) => options,
    query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
      const iterator = (async function* () {
        const server = (options['mcpServers'] as { repo: { tools: FakeTool[] } }).repo;
        const messages: Array<Record<string, unknown>> = [{ role: 'user', content: prompt }];
        const maxTurns = Number(options['maxTurns'] ?? 1);
        for (let turn = 0; turn < maxTurns; turn++) {
          const response = await messagesCreate({
            model: options['model'],
            system: [{ type: 'text', text: options['systemPrompt'] }],
            messages: structuredClone(messages),
            tools: server.tools.map((candidate) => ({
              name: candidate.name,
              description: candidate.description,
              input_schema: candidate.inputSchema,
            })),
          });
          const calls = response.content.filter((block) => block['type'] === 'tool_use');
          const results: Array<Record<string, unknown>> = [];
          let accepted = false;
          for (const call of calls) {
            const name = String(call['name']);
            const selected = server.tools.find((candidate) => candidate.name === name);
            const result = selected
              ? await selected.handler((call['input'] ?? {}) as Record<string, unknown>)
              : { content: [{ type: 'text' as const, text: `Unknown tool ${name}` }], isError: true };
            const text = result.content.map((entry) => entry.text).join('\n');
            if (!result.isError && text === 'Submission recorded.') accepted = true;
            results.push({
              type: 'tool_result', tool_use_id: call['id'], content: text,
              ...(result.isError ? { is_error: true } : {}),
            });
          }
          // The real SDK has completed custom tool handlers by the time the
          // consumer can observe the assistant boundary. In particular, a
          // terminal submission and the usage that paid for it are visible
          // together, so terminal capture wins over a simultaneous budget cap.
          yield {
            type: 'assistant', uuid: `a-${turn}`, session_id: 'test', parent_tool_use_id: null,
            message: {
              id: `m-${turn}`, type: 'message', role: 'assistant', model: String(options['model']),
              content: response.content, stop_reason: response.stop_reason ?? null, stop_sequence: null,
              usage: response.usage,
            },
          };
          messages.push({ role: 'assistant', content: response.content });
          if (calls.length === 0) return;
          messages.push({ role: 'user', content: results });
          if (accepted) return;
        }
      })();
      return {
        [Symbol.asyncIterator]: () => iterator,
        next: () => iterator.next(),
        return: async () => ({ done: true as const, value: undefined }),
      };
    },
  };
}
