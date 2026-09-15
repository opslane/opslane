import type Anthropic from '@anthropic-ai/sdk';
import type {
  MessagePart,
  ModelMessage,
  ModelPort,
  ModelResponse,
  TextPart,
  ToolResultPart,
  ToolUsePart,
} from './model-port.js';

export interface AnthropicModelPortOptions {
  maxTokens?: number;
}

export function createAnthropicModelPort(
  client: Anthropic,
  options: AnthropicModelPortOptions = {},
): ModelPort {
  return {
    async generate(request): Promise<ModelResponse> {
      const response = await client.messages.create(
        {
          model: request.model,
          max_tokens: options.maxTokens ?? 16_384,
          system: request.system.map((block) => ({
            type: 'text' as const,
            text: block.text,
            ...(block.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
          })),
          messages: toAnthropicMessages(request.messages),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.schema as Anthropic.Tool.InputSchema,
          })),
        },
        { signal: request.signal },
      );

      const content: Array<TextPart | ToolUsePart> = [];
      for (const block of response.content) {
          if (block.type === 'text') content.push({ type: 'text', text: block.text });
          if (block.type === 'tool_use') {
            content.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: asRecord(block.input),
            });
          }
      }

      return {
        content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
        stopReason: response.stop_reason,
        ...(typeof (response as { _request_id?: unknown })._request_id === 'string'
          ? { requestId: (response as unknown as { _request_id: string })._request_id }
          : {}),
      };
    },
  };
}

function toAnthropicMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  const mapped = messages.map((message): Anthropic.MessageParam => ({
    role: message.role,
    content: message.content.map(toAnthropicPart) as Anthropic.MessageParam['content'],
  }));

  for (let index = mapped.length - 1; index >= 0; index--) {
    const message = mapped[index];
    if (message?.role !== 'user' || !Array.isArray(message.content) || message.content.length === 0) continue;
    const lastBlock = message.content[message.content.length - 1];
    (lastBlock as unknown as Record<string, unknown>)['cache_control'] = { type: 'ephemeral' };
    break;
  }

  return mapped;
}

function toAnthropicPart(part: MessagePart): Anthropic.ContentBlockParam {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (part.type === 'tool_use') {
    return { type: 'tool_use', id: part.id, name: part.name, input: part.input };
  }
  return toAnthropicToolResult(part);
}

function toAnthropicToolResult(part: ToolResultPart): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: part.toolUseId,
    content: part.output,
    is_error: part.isError,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
