// A stdio MCP server that only starts once a "ready" marker file exists. Used
// to verify that a server which failed to connect (marker absent) is retried on
// a later refresh — with the SAME config — once it can connect (marker present).
import fs from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const readyFile = process.env.MCP_READY_FILE;
if (!readyFile || !fs.existsSync(readyFile)) {
  console.error("flaky MCP fixture: not ready");
  process.exit(1);
}

const server = new McpServer({
  name: "test-flaky-server",
  version: "1.0.0"
});

server.registerTool(
  "ping",
  {
    annotations: {
      readOnlyHint: true,
      title: "Ping"
    },
    description: "Reply with pong.",
    inputSchema: {
      text: z.string().optional()
    },
    title: "Ping"
  },
  async () => ({
    content: [
      {
        text: "pong",
        type: "text"
      }
    ]
  })
);

const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error("Failed to start flaky stdio MCP fixture:", error);
  process.exitCode = 1;
});
