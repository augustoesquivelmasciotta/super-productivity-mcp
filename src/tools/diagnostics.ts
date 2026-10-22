import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SuperProductivityClient } from '../client/sp-client.js';

export function setupDiagnosticsTools(server: McpServer, client: SuperProductivityClient) {
  server.registerTool(
    'check_connection',
    {
      description:
        'Reports whether the Super Productivity plugin bridge is currently connected to this MCP server, plus the last startup heartbeat (plugin version), registered hooks, command count, and uptime. Use to self-diagnose a dead bridge without grepping the server log.',
      inputSchema: {},
    },
    async () => {
      try {
        const status = client.getConnectionStatus();
        return {
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
