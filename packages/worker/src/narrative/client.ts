import Anthropic from '@anthropic-ai/sdk';

export interface NarrativeClientConfig {
  model: string;
  baseURL?: string;
  apiKey: string;
  maxTokens: number;
  reasoning: 'on' | 'off';
}

export interface NarrativeModelResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export function extractJsonObject(text: string): string {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenceMatch?.[1]?.trim() ?? text;
  const start = candidate.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, index + 1);
    }
  }
  return '';
}

export class NarrativeClient {
  private readonly anthropic: Anthropic;
  private readonly config: NarrativeClientConfig;
  readonly modelName: string;

  constructor(config: NarrativeClientConfig) {
    this.config = config;
    this.modelName = config.model;
    this.anthropic = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: 120_000,
    });
  }

  async complete(args: {
    system: string;
    user: string;
    images?: Array<{ mediaType: string; base64: string }>;
  }): Promise<NarrativeModelResult> {
    const content: Anthropic.MessageParam['content'] = args.images?.length
      ? [
          { type: 'text', text: args.user },
          ...args.images.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: image.mediaType as 'image/png',
              data: image.base64,
            },
          })),
        ]
      : args.user;
    const response = await this.anthropic.messages.create({
      model: this.config.model,
      max_tokens: this.config.reasoning === 'on'
        ? this.config.maxTokens + 4_096
        : this.config.maxTokens,
      ...(this.config.reasoning === 'on'
        ? { thinking: { type: 'enabled' as const, budget_tokens: 4_096 } }
        : {}),
      system: args.system,
      messages: [{ role: 'user', content }],
    });
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    return {
      text,
      inputTokens: Number.isFinite(usage?.input_tokens) ? usage?.input_tokens ?? 0 : 0,
      outputTokens: Number.isFinite(usage?.output_tokens) ? usage?.output_tokens ?? 0 : 0,
      stopReason: response.stop_reason ?? 'unknown',
    };
  }
}

export function narrativeClientFromEnv(): NarrativeClient | null {
  const apiKey = process.env['NARRATIVE_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return null;
  const parsedMax = Number(process.env['NARRATIVE_MAX_TOKENS']);
  return new NarrativeClient({
    model: process.env['NARRATIVE_MODEL'] ?? 'claude-sonnet-5',
    baseURL: process.env['NARRATIVE_BASE_URL'] || undefined,
    apiKey,
    maxTokens: Number.isFinite(parsedMax) && parsedMax >= 1_024 ? Math.floor(parsedMax) : 8_192,
    reasoning: process.env['NARRATIVE_REASONING'] === 'on' ? 'on' : 'off',
  });
}
