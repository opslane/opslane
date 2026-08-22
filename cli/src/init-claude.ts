import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SERVER = { command: 'opslane', args: ['mcp'] } as const;

export async function installClaudeIntegration(options: {
  cwd: string;
  skill: string;
}): Promise<{ skillPath: string; mcpPath: string; mcpChanged: boolean }> {
  const skillPath = join(options.cwd, '.claude', 'skills', 'opslane', 'SKILL.md');
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(skillPath, options.skill, 'utf8');

  const mcpPath = join(options.cwd, '.mcp.json');
  let existing = '';
  try {
    existing = await readFile(mcpPath, 'utf8');
  } catch {
    existing = '';
  }

  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existing.trim() !== '') {
    try {
      config = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    } catch {
      throw new Error(
        `${mcpPath} is not valid JSON. Fix or remove it, then run this again. Refusing to overwrite it.`,
      );
    }
  }

  const servers = config.mcpServers ?? {};
  if (JSON.stringify(servers['opslane']) === JSON.stringify(SERVER)) {
    return { skillPath, mcpPath, mcpChanged: false };
  }

  const next = { ...config, mcpServers: { ...servers, opslane: SERVER } };
  await writeFile(mcpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { skillPath, mcpPath, mcpChanged: true };
}
