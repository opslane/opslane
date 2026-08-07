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
  it('exposes submit_diagnosis, not give_up', () => {
    const tools = createToolBridge(makeMockSandbox() as unknown as SandboxRuntime, makeState());
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('submit_diagnosis');
    expect(names).not.toContain('give_up');
  });

  it('takes no reason_code from the model', () => {
    const tools = createToolBridge(makeMockSandbox() as unknown as SandboxRuntime, makeState());
    const tool = tools.find((candidate) => candidate.name === 'submit_diagnosis')!;
    const properties = tool.inputSchema['properties'] as Record<string, unknown>;
    expect(properties['reason_code']).toBeUndefined();
  });

  it('creates the repository tools plus submit_diagnosis', () => {
    const sandbox = makeMockSandbox();
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState());
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(['bash', 'edit', 'patch', 'read', 'read_many', 'search', 'submit_diagnosis', 'write']);
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

  it('submit_diagnosis sets state.gaveUp and stores the raw diagnosis', async () => {
    const sandbox = makeMockSandbox();
    const state = makeState();
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, state);
    const diagnosisTool = tools.find(t => t.name === 'submit_diagnosis')!;
    await diagnosisTool.execute({
      one_line_description: 'The CDN is unavailable',
      why_chain: ['Client requests asset', 'CDN does not respond', 'Request times out'],
      reproduction_steps: ['Load the affected asset'],
      cause_location: 'https://cdn.example.com/app.js',
      change_counterfactual: 'No repository change makes the CDN respond',
    });
    expect(state.gaveUp).toBe(true);
    expect(state.submittedDiagnosis?.['cause_location']).toBe('https://cdn.example.com/app.js');
    expect(state.giveUpReason).toBeUndefined();
  });
});

/**
 * The fix surface is an authorization boundary and the bridge is where the
 * write actually happens. `bash` is deliberately not covered: it can write
 * anywhere and no tool-level check reaches it.
 */
describe('mutation tools are gated on the fix surface', () => {
  const SURFACE = { globs: ['client/**'] };
  const OUTSIDE = '/home/user/repo/server/app/asset.py';
  const INSIDE = '/home/user/repo/client/src/AssetList.tsx';

  function argsFor(tool: 'write' | 'edit' | 'patch', path: string): Record<string, unknown> {
    if (tool === 'write') return { path, content: 'changed\n' };
    if (tool === 'edit') return { path, old_string: 'def get(): pass', new_string: 'def get(): return 1' };
    return { diff: `--- a/${path.replace('/home/user/repo/', '')}\n+++ b/${path.replace('/home/user/repo/', '')}\n` };
  }

  for (const tool of ['write', 'edit', 'patch'] as const) {
    it(`refuses ${tool} outside the surface, and does not touch the file`, async () => {
      const sandbox = makeMockSandbox();
      sandbox.files.read.mockResolvedValue('def get(): pass\n');
      const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState(), 'javascript', SURFACE);

      const result = await tools.find((t) => t.name === tool)!.execute(argsFor(tool, OUTSIDE));

      expect(result).toContain('outside the configured fix surface');
      expect(sandbox.files.write).not.toHaveBeenCalled();
      expect(sandbox.commands.run).not.toHaveBeenCalled();
    });

    it(`allows ${tool} inside the surface`, async () => {
      const sandbox = makeMockSandbox();
      sandbox.files.read.mockResolvedValue('def get(): pass\n');
      sandbox.commands.run.mockResolvedValue({ exitCode: 0, stdout: 'patching file', stderr: '' });
      const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState(), 'javascript', SURFACE);

      const result = await tools.find((t) => t.name === tool)!.execute(argsFor(tool, INSIDE));

      expect(result).not.toContain('outside the configured fix surface');
    });
  }

  it('refuses a patch whose targets it cannot read, rather than applying it blind', async () => {
    const sandbox = makeMockSandbox();
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState(), 'javascript', SURFACE);

    const result = await tools.find((t) => t.name === 'patch')!.execute({ diff: 'not a diff at all\n' });

    expect(result).toContain('Refusing to apply a patch');
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it('refuses a write that traverses out of the repository', async () => {
    const sandbox = makeMockSandbox();
    const tools = createToolBridge(sandbox as unknown as SandboxRuntime, makeState(), 'javascript', { globs: null });

    const result = await tools.find((t) => t.name === 'write')!
      .execute({ path: '/home/user/repo/../../etc/passwd', content: 'x' });

    expect(result).toContain('does not resolve inside the repository');
    expect(sandbox.files.write).not.toHaveBeenCalled();
  });
});
