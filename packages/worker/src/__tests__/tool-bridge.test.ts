import { describe, it, expect, vi } from 'vitest';
import { createToolBridge } from '../harness/tool-bridge.js';
import type { AgentState } from '../harness/types.js';
import type { SandboxRuntime } from '../harness/sandbox-runtime.js';

function makeMockSandbox() {
  return {
    id: 'fake-sandbox',
    createdAt: 0,
    lifetimeMs: 1_800_000,
    unavailable: false,
    files: {
      read: vi.fn(),
      write: vi.fn(),
    },
    commands: {
      run: vi.fn(),
    },
    kill: vi.fn(),
  };
}

function makeState(): AgentState {
  return {
    turnCount: 0,
    toolCallCount: 0,
    editCounts: new Map(),
    testsRan: false,
    gaveUp: false,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stackTraceFiles: [],
    scopeReviewDone: false,
    toolHistoryEntries: [],
  };
}

describe('createToolBridge', () => {
  it('creates 8 tools (read, write, edit, bash, read_many, search, patch, give_up)', () => {
    const sandbox = makeMockSandbox();
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState());
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(['bash', 'edit', 'give_up', 'patch', 'read', 'read_many', 'search', 'write']);
  });

  it('read tool returns file contents from sandbox', async () => {
    const sandbox = makeMockSandbox();
    sandbox.files.read.mockResolvedValue('const x = 1;');
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState());
    const readTool = tools.find(t => t.name === 'read')!;
    const result = await readTool.execute({ path: '/home/user/repo/src/foo.ts' });
    expect(result).toBe('const x = 1;');
  });

  it('edit tool replaces exact string in file', async () => {
    const sandbox = makeMockSandbox();
    sandbox.files.read.mockResolvedValue('const x = 1;\nconst y = 2;');
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState());
    const editTool = tools.find(t => t.name === 'edit')!;
    const result = await editTool.execute({
      path: '/home/user/repo/src/foo.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 42;',
    });
    expect(result).toContain('Applied edit');
    expect(sandbox.files.write).toHaveBeenCalledWith(
      '/home/user/repo/src/foo.ts',
      'const x = 42;\nconst y = 2;',
    );
  });

  it('edit tool errors when old_string not found', async () => {
    const sandbox = makeMockSandbox();
    sandbox.files.read.mockResolvedValue('const x = 1;');
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState());
    const editTool = tools.find(t => t.name === 'edit')!;
    const result = await editTool.execute({
      path: '/home/user/repo/src/foo.ts',
      old_string: 'NOT FOUND',
      new_string: 'replacement',
    });
    expect(result).toContain('Error: old_string not found');
  });

  it('bash tool returns stdout on success', async () => {
    const sandbox = makeMockSandbox();
    sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: 'hello', stderr: '' });
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState());
    const bashTool = tools.find(t => t.name === 'bash')!;
    const result = await bashTool.execute({ command: 'echo hello' });
    expect(result).toBe('hello');
  });

  it('bash tool returns stderr on failure', async () => {
    const sandbox = makeMockSandbox();
    sandbox.commands.run.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState());
    const bashTool = tools.find(t => t.name === 'bash')!;
    const result = await bashTool.execute({ command: 'bad-cmd' });
    expect(result).toContain('Exit code: 1');
    expect(result).toContain('not found');
  });

  it('give_up tool sets state.gaveUp and stores reason', async () => {
    const sandbox = makeMockSandbox();
    const state = makeState();
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, state);
    const giveUpTool = tools.find(t => t.name === 'give_up')!;
    await giveUpTool.execute({
      reason_code: 'worker_runtime_error',
      reason_message: 'CDN is down',
      remediation: 'Check CDN status',
    });
    expect(state.gaveUp).toBe(true);
    expect(state.giveUpReason?.reason_code).toBe('worker_runtime_error');
  });
});
