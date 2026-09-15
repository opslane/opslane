export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolUseId: string;
  output: string;
  isError: boolean;
}

export type MessagePart = TextPart | ToolUsePart | ToolResultPart;

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: MessagePart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<string> | string;
}

export interface ModelTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelRequest {
  model: string;
  system: SystemBlock[];
  messages: ModelMessage[];
  tools: ModelTool[];
  signal?: AbortSignal;
}

export interface ModelResponse {
  content: Array<TextPart | ToolUsePart>;
  usage: ModelUsage;
  stopReason: string | null;
  requestId?: string;
}

export interface ModelPort {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
