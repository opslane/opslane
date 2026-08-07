export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  output: string;
  isError?: boolean;
}

export interface ToolHistoryEntry {
  name: string;
  input: Record<string, unknown>;
}

export interface AgentCompletionResult {
  success: boolean;
  summary: string;
  toolCallCount: number;
  turnCount: number;
  testsRan: boolean;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  toolHistory: ToolHistoryEntry[];
}

export interface ToolMiddleware {
  preTool?: (call: ToolCall, state: AgentState) => Promise<{ allow: boolean; inject?: string } | void>;
  postTool?: (call: ToolCall, result: ToolResult, state: AgentState) => Promise<void>;
  preCompletion?: (state: AgentState) => Promise<{ inject?: string } | void>;
}

export interface AgentState {
  turnCount: number;
  toolCallCount: number;
  editCounts: Map<string, number>;
  testsRan: boolean;
  gaveUp: boolean;
  giveUpReason?: { reason_code: string; reason_message: string; remediation: string };
  /** Raw submit_diagnosis input. The caller derives routing and giveUpReason. */
  submittedDiagnosis?: Record<string, unknown>;
  tokenUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** File paths from the stack trace (relative, e.g. 'src/App.vue'). Empty = unknown scope. */
  stackTraceFiles: string[];
  /** Whether the scope review nudge has already fired this attempt. */
  scopeReviewDone: boolean;
  /** Accumulated tool calls for cascade context forwarding. */
  toolHistoryEntries: ToolHistoryEntry[];
}

export type AgentEventHandler = (event: AgentHarnessEvent) => void;

export type AgentHarnessEvent =
  | { type: 'message'; content: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; output: string; isError?: boolean }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'turn_end'; turnNumber: number; tokenUsage: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }
  | { type: 'completed'; summary: string }
  | { type: 'error'; code: string; message: string };

export interface AgentLoopConfig {
  apiKey: string;
  model?: string;
  maxTurns: number;
  systemPrompt: string;
  tools: ToolDefinition[];
  middleware?: ToolMiddleware;
  onEvent: AgentEventHandler;
  abortSignal?: AbortSignal;
  budgetUsd?: number;
  /** Pass an external AgentState to share with tool bridge. If omitted, a fresh state is created internally. */
  externalState?: AgentState;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

// Re-export types needed by other modules that used to import from rca-fix.ts
export interface SourceFile {
  filePath: string;
  content: string;
}

export interface VisualAnalysisOutput {
  whatUserSaw: string;
  failureMoment: string;
  uxImpact: string;
  confidence: string;
}
