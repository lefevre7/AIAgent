import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const server = new McpServer({
  name: "test-stdio-server",
  version: "1.0.0"
});

server.registerTool(
  "docs.lookup",
  {
    annotations: {
      idempotentHint: true,
      readOnlyHint: true,
      title: "Docs Lookup"
    },
    description: "Look up documentation by topic.",
    inputSchema: {
      topic: z.string().min(1)
    },
    outputSchema: {
      topic: z.string(),
      summary: z.string()
    },
    title: "Docs Lookup"
  },
  async ({ topic }) => ({
    content: [
      {
        text: `lookup:${topic}`,
        type: "text"
      }
    ],
    structuredContent: {
      summary: `Documentation for ${topic}`,
      topic
    }
  })
);

server.registerPrompt(
  "summarize_doc",
  {
    argsSchema: {
      topic: z.string().min(1)
    },
    description: "Build a summary prompt for a topic."
  },
  async ({ topic }) => ({
    description: `Prompt for ${topic}`,
    messages: [
      {
        content: {
          text: `Summarize the documentation for ${topic}.`,
          type: "text"
        },
        role: "user"
      }
    ]
  })
);

server.registerResource(
  "guide",
  "file:///docs/guide.md",
  {
    description: "Static guide resource.",
    mimeType: "text/markdown",
    title: "Guide"
  },
  async (uri) => ({
    contents: [
      {
        mimeType: "text/markdown",
        text: "# Guide\nStatic guide content.\n",
        uri: uri.toString()
      }
    ]
  })
);

server.registerResource(
  "doc-template",
  new ResourceTemplate("file:///docs/{name}.md", {
    list: undefined
  }),
  {
    description: "Dynamic document resource template.",
    mimeType: "text/markdown",
    title: "Document Template"
  },
  async (uri) => {
    const name = decodeURIComponent(uri.pathname.split("/").pop() ?? "unknown").replace(/\.md$/i, "");
    return {
      contents: [
        {
          mimeType: "text/markdown",
          text: `# ${name}\nDynamic content for ${name}.\n`,
          uri: uri.toString()
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();

server.connect(transport).catch((error) => {
  console.error("Failed to start stdio MCP fixture:", error);
  process.exitCode = 1;
});
