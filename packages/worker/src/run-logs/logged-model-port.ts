import type { ModelPort } from '@opslane/agent-core';
import { modelResponseEvent } from '@opslane/agent-runs';
import type { RunHandle } from './handle.js';
import { countRunLogFailure } from './sink.js';

/**
 * Log every provider response. Follow-up requests are counted but not logged:
 * they are the bundle's first request plus the logged responses, tool results
 * and injected feedback. Agent-core's Anthropic port sends no `thinking`
 * parameter, so no thinking blocks exist to lose in its reduction; enabling
 * thinking for the fix agent would require the port to return raw blocks first.
 */
export function loggedModelPort(port: ModelPort, run: RunHandle): ModelPort {
  return {
    async generate(request) {
      try { run.countRequest(); } catch { countRunLogFailure('transcript'); }
      const response = await port.generate(request);
      try {
        run.event(modelResponseEvent(request.model, {
          content: response.content,
          usage: {
            input: response.usage.inputTokens,
            output: response.usage.outputTokens,
            cacheRead: response.usage.cacheReadTokens,
            cacheWrite: response.usage.cacheWriteTokens,
          },
          stopReason: response.stopReason,
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        }));
      } catch { countRunLogFailure('transcript'); }
      return response;
    },
  };
}
