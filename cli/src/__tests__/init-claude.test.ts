import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installClaudeIntegration } from '../init-claude.js';

const SKILL = '---\nname: opslane\n---\nbody\n';

async function repo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'opslane-init-'));
}

describe('installClaudeIntegration', () => {
  it('writes the skill where Claude Code looks for it', async () => {
    const cwd = await repo();
    const result = await installClaudeIntegration({ cwd, skill: SKILL });
    expect(result.skillPath).toBe(join(cwd, '.claude', 'skills', 'opslane', 'SKILL.md'));
    await expect(readFile(result.skillPath, 'utf8')).resolves.toContain('name: opslane');
  });

  it('registers the server in .mcp.json', async () => {
    const cwd = await repo();
    const result = await installClaudeIntegration({ cwd, skill: SKILL });
    const config = JSON.parse(await readFile(result.mcpPath, 'utf8'));
    expect(config.mcpServers.opslane).toEqual({ command: 'opslane', args: ['mcp'] });
    expect(result.mcpChanged).toBe(true);
  });

  it('preserves servers already configured', async () => {
    const cwd = await repo();
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
      'utf8',
    );
    const result = await installClaudeIntegration({ cwd, skill: SKILL });
    const config = JSON.parse(await readFile(result.mcpPath, 'utf8'));
    expect(config.mcpServers.other).toEqual({ command: 'other' });
    expect(config.mcpServers.opslane).toBeDefined();
  });

  it('is idempotent', async () => {
    const cwd = await repo();
    await installClaudeIntegration({ cwd, skill: SKILL });
    expect((await installClaudeIntegration({ cwd, skill: SKILL })).mcpChanged).toBe(false);
  });

  it('refuses to overwrite a malformed .mcp.json', async () => {
    const cwd = await repo();
    await writeFile(join(cwd, '.mcp.json'), '{ not json', 'utf8');
    await expect(installClaudeIntegration({ cwd, skill: SKILL })).rejects.toThrow(/\.mcp\.json/);
  });
});
