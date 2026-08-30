import { describe, expect, it, vi } from 'vitest';
import { CommandExitError } from 'e2b';
import { createSandboxReader, MachineUnavailableError } from '../readonly-sandbox.js';

function fake(run: (cmd: string) => Promise<{ stdout: string }>, running: () => Promise<boolean> = async () => true) {
  return { sandboxId: 'sbx', isRunning: vi.fn(running), commands: { run: vi.fn(run) }, kill: vi.fn(async () => undefined) };
}

describe('createSandboxReader containment', () => {
  it('resolves the path inside the machine and bounds the read', async () => {
    const sbx = fake(async () => ({ stdout: 'x' }));
    await createSandboxReader(sbx as never, '/home/user/repo').readFile('src/a.ts');
    const cmd = sbx.commands.run.mock.calls[0]![0] as string;
    expect(cmd).toContain('realpath');
    expect(cmd).toContain('head -c');
    expect(cmd).toContain("'src/a.ts'");
  });

  it('turns the containment failure exit code into a refusal, not a machine error', async () => {
    const sbx = fake(async () => { throw new CommandExitError({ exitCode: 3, stdout: '', stderr: 'PATH_OUTSIDE', error: undefined } as never); });
    await expect(createSandboxReader(sbx as never, '/home/user/repo').readFile('../../etc/passwd'))
      .rejects.toThrow('path escapes the repository');
  });

  it('single-quotes model-supplied strings', async () => {
    const sbx = fake(async () => ({ stdout: '' }));
    await createSandboxReader(sbx as never, '/home/user/repo').readFile("a'; rm -rf /; '.ts");
    expect(sbx.commands.run.mock.calls[0]![0] as string).toContain(`'a'\\''; rm -rf /; '\\''.ts'`);
  });

  it('reports a missing path the way the host reader did, so the tool still says file not found', async () => {
    const sbx = fake(async () => { throw new CommandExitError({ exitCode: 4, stdout: '', stderr: '', error: undefined } as never); });
    await expect(createSandboxReader(sbx as never, '/home/user/repo').readFile('src/gone.ts'))
      .rejects.toThrow('No such file or directory');
  });
});

describe('createSandboxReader failure classification', () => {
  it('raises MachineUnavailableError with state gone when the probe says not running', async () => {
    const sbx = fake(async () => { throw new Error('2: [unknown] terminated'); }, async () => false);
    await expect(createSandboxReader(sbx as never, '/r').readFile('a.ts')).rejects.toMatchObject({
      name: 'MachineUnavailableError', state: 'gone',
    });
  });

  it('raises state unknown when the probe itself fails, never gone', async () => {
    const sbx = fake(async () => { throw new Error('2: [unknown] terminated'); }, async () => { throw new Error('unreachable'); });
    await expect(createSandboxReader(sbx as never, '/r').readFile('a.ts')).rejects.toMatchObject({ state: 'unknown' });
  });

  it('lets an ordinary command failure through unchanged', async () => {
    const exit = new CommandExitError({ exitCode: 2, stdout: '', stderr: 'grep: bad', error: undefined } as never);
    const sbx = fake(async () => { throw exit; });
    await expect(createSandboxReader(sbx as never, '/r').grep(['-r', 'x', '.']))
      .rejects.not.toBeInstanceOf(MachineUnavailableError);
  });

  it('returns empty stdout for grep exit 1, which means no matches', async () => {
    const exit = new CommandExitError({ exitCode: 1, stdout: '', stderr: '', error: undefined } as never);
    const sbx = fake(async () => { throw exit; });
    expect(await createSandboxReader(sbx as never, '/r').grep(['-r', 'x', '.'])).toBe('');
  });
});

describe('createSandboxReader listing', () => {
  it('prunes vendored directories, marks directories, and prefixes the requested path', async () => {
    const sbx = fake(async () => ({ stdout: 'f\ta.ts\nd\tnested\n' }));
    const out = await createSandboxReader(sbx as never, '/home/user/repo').list('src', false);
    const cmd = sbx.commands.run.mock.calls[0]![0] as string;
    expect(cmd).toContain('-maxdepth 1');
    expect(cmd).toContain("-name 'node_modules'");
    expect(cmd).toContain('-prune');
    expect(out).toBe('src/a.ts\nsrc/nested/');
  });

  it('descends one more level when the model asks recursively', async () => {
    const sbx = fake(async () => ({ stdout: '' }));
    await createSandboxReader(sbx as never, '/home/user/repo').list('.', true);
    expect(sbx.commands.run.mock.calls[0]![0] as string).toContain('-maxdepth 2');
  });

  it('says the directory is empty rather than returning nothing', async () => {
    const sbx = fake(async () => ({ stdout: '\n' }));
    expect(await createSandboxReader(sbx as never, '/home/user/repo').list('.', false)).toBe('Empty directory.');
  });
});
