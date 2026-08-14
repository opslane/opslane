import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { OpslaneClient } from './client.js';
import { registerTools } from './tools.js';

/** stdio carries the protocol, so nothing in this process may write to stdout.
 * Diagnostics go to console.error. */
export async function startMcpServer(client: OpslaneClient): Promise<void> {
  const server = new McpServer({ name: 'opslane', version: '0.1.0' });
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
}
