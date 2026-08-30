import { describe, expect, it, vi } from 'vitest';
import { CommandExitError, TimeoutError } from 'e2b';
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

describe('createSandboxReader output bounds', () => {
  const ROOT = '/home/user/repo';

  it('caps grep output inside the machine while preserving its exit code', async () => {
    // The host reader gave execFile a 512KB maxBuffer. Without an equivalent, a
    // `grep -r` over a large checkout materialises its whole result set in the
    // worker process: investigate-tools truncates only after the bytes have
    // already crossed the wire.
    const sbx = fake(async () => ({ stdout: '' }));
    await createSandboxReader(sbx as never, ROOT).grep(['-r', '--', 'x', '.']);
    const cmd = sbx.commands.run.mock.calls[0]![0] as string;
    expect(cmd).toContain('head -c 524288');
    // A pipeline would report head's status and mask grep's "no matches" 1.
    expect(cmd).not.toMatch(/grep[^|]*\|\s*head/);
    expect(cmd).toContain('exit $s');
  });

  it('still reports no matches as an empty result rather than an error', async () => {
    const sbx = fake(async () => {
      throw new CommandExitError({ exitCode: 1, stdout: '', stderr: '', error: undefined } as never);
    });
    expect(await createSandboxReader(sbx as never, ROOT).grep(['-r', '--', 'nope', '.'])).toBe('');
  });

  it('caps directory listing output too', async () => {
    const sbx = fake(async () => ({ stdout: '' }));
    await createSandboxReader(sbx as never, ROOT).list('.', true);
    expect(sbx.commands.run.mock.calls[0]![0] as string).toContain('head -c 524288');
  });

  it('probes citations in batches, so a long list cannot overrun the command length', async () => {
    // The citation list comes from the model and the tool schema cannot bound it
    // (the API rejects array bounds). One oversized command fails as a transport
    // error, which reads as machine death and retries as infrastructure — a
    // model-chosen input laundered into the durable retry lane.
    const paths = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
    const sbx = fake(async (cmd: string) => ({
      stdout: paths.filter((path) => cmd.includes(`'${path}'`)).join('\n'),
    }));
    const found = await createSandboxReader(sbx as never, ROOT).exists(paths);
    expect(sbx.commands.run).toHaveBeenCalledTimes(3);
    expect(found).toEqual(paths);
  });

  it('stops probing past the ceiling instead of issuing unbounded round trips', async () => {
    const paths = Array.from({ length: 1_500 }, (_, i) => `src/f${i}.ts`);
    const sbx = fake(async (cmd: string) => ({
      stdout: paths.filter((path) => cmd.includes(`'${path}'`)).join('\n'),
    }));
    const found = await createSandboxReader(sbx as never, ROOT).exists(paths);
    expect(sbx.commands.run).toHaveBeenCalledTimes(10);
    expect(found).toHaveLength(1_000);
  });
});

describe('createSandboxReader failure classification', () => {
  it('reports a read deadline to the model instead of killing the run', async () => {
    // classifyFailure calls a deadline `unknown` — right for a verification
    // suite, which should retry the whole job. Here it meant one slow
    // model-chosen grep raised MachineUnavailableError and sent the whole
    // investigation round the infra-retry lane, where the model would plausibly
    // issue the same search again. The host reader handed the message back so it
    // could narrow the search.
    const sbx = fake(async () => { throw new TimeoutError('exceeding the timeout for command execution'); });
    const failure = createSandboxReader(sbx as never, '/r').grep(['-r', '--', 'x', '.']);
    await expect(failure).rejects.toThrow('did not finish within 30s');
    await expect(failure).rejects.not.toBeInstanceOf(MachineUnavailableError);
  });

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
