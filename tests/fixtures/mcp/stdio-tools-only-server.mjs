// A stdio MCP server that registers ONLY a tool — no resources, resource
// templates, or prompts. Used to verify that a tools-only server (which replies
// MethodNotFound to resources/list and prompts/list) still connects with its
// tools intact instead of being discarded as "failed" (see F8).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const server = new McpServer({
  name: "test-tools-only-server",
  version: "1.0.0"
});

server.registerTool(
  "echo",
  {
    annotations: {
      readOnlyHint: true,
      title: "Echo"
    },
    description: "Echo the provided text back.",
    inputSchema: {
      text: z.string().min(1)
    },
    outputSchema: {
      echoed: z.string()
    },
    title: "Echo"
  },
  async ({ text }) => ({
    content: [
      {
        text: `echo:${text}`,
        type: "text"
      }
    ],
    structuredContent: {
      echoed: text
    }
  })
);

const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error("Failed to start tools-only stdio MCP fixture:", error);
  process.exitCode = 1;
});
