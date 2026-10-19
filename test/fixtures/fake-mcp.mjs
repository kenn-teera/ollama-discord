import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'fake', version: '1' });
server.tool('ok', 'returns text', {}, async () => ({ content: [{ type: 'text', text: 'all good' }] }));
server.tool('boom', 'fails with the MCP error flag', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'Error: backend down' }] }));
await server.connect(new StdioServerTransport());
