import type { AppConfig } from "@/core/config";

export type MCPServerTemplateDefinition = AppConfig["mcp"]["templates"][string];

export const BUILT_IN_MCP_SERVER_TEMPLATES: Record<string, MCPServerTemplateDefinition> = {
  "context7-remote": {
    bootstrap: [],
    description: "Remote Context7 MCP server over Streamable HTTP for documentation lookup and library docs retrieval.",
    displayName: "Context7 Remote",
    marketplace: true,
    prerequisites: ["Optional API key for higher rate limits and private repositories."],
    server: {
      description: "Context7 remote MCP endpoint.",
      enabled: true,
      headers: {},
      provenance: {
        source: "template",
        templateId: "context7-remote"
      },
      required: false,
      tags: ["context7", "docs", "search"],
      type: "auto",
      url: "https://mcp.context7.com/mcp"
    },
    tags: ["catalog", "context7", "docs", "marketplace", "remote"],
    title: "Context7 Remote"
  },
  "context7-stdio": {
    bootstrap: [
      {
        args: ["install", "@upstash/context7-mcp@latest"],
        command: "npm",
        notes: "Optional local install. You can also rely on npx."
      }
    ],
    description: "Local stdio Context7 server launched through npx.",
    displayName: "Context7 Local",
    marketplace: true,
    prerequisites: ["Node.js and npx must be available.", "Optional Context7 API key for higher rate limits."],
    server: {
      args: ["-y", "@upstash/context7-mcp@latest"],
      command: "npx",
      description: "Context7 local MCP server via npx.",
      enabled: true,
      env: {},
      provenance: {
        source: "template",
        templateId: "context7-stdio"
      },
      required: false,
      stderr: "pipe",
      tags: ["context7", "docs", "search"],
      type: "stdio"
    },
    tags: ["catalog", "context7", "docs", "local", "marketplace"],
    title: "Context7 Local"
  },
  "custom-http": {
    bootstrap: [],
    description: "Generic remote MCP server template using HTTP with automatic Streamable HTTP to SSE fallback.",
    displayName: "Custom HTTP MCP Server",
    marketplace: false,
    prerequisites: ["Provide the server URL and any required headers."],
    server: {
      description: "Fill in the remote MCP endpoint details.",
      enabled: true,
      headers: {},
      provenance: {
        source: "template",
        templateId: "custom-http"
      },
      required: false,
      tags: ["custom", "http"],
      type: "auto",
      url: "https://example.com/mcp"
    },
    tags: ["custom", "http", "starter"],
    title: "Custom HTTP MCP Server"
  },
  "custom-sse": {
    bootstrap: [],
    description: "Generic legacy SSE MCP server template for older servers that do not support Streamable HTTP yet.",
    displayName: "Custom SSE MCP Server",
    marketplace: false,
    prerequisites: ["Provide the legacy SSE endpoint URL."],
    server: {
      description: "Fill in the legacy SSE MCP endpoint details.",
      enabled: true,
      headers: {},
      provenance: {
        source: "template",
        templateId: "custom-sse"
      },
      required: false,
      tags: ["custom", "legacy", "sse"],
      type: "sse",
      url: "https://example.com/sse"
    },
    tags: ["custom", "legacy", "sse", "starter"],
    title: "Custom SSE MCP Server"
  },
  "custom-stdio": {
    bootstrap: [],
    description: "Generic local stdio MCP server template for any command-based server.",
    displayName: "Custom Stdio MCP Server",
    marketplace: false,
    prerequisites: ["Provide the command, args, and optional working directory."],
    server: {
      args: [],
      command: "node",
      description: "Fill in the local stdio MCP server command.",
      enabled: true,
      env: {},
      provenance: {
        source: "template",
        templateId: "custom-stdio"
      },
      required: false,
      stderr: "pipe",
      tags: ["custom", "local", "stdio"],
      type: "stdio"
    },
    tags: ["custom", "local", "starter", "stdio"],
    title: "Custom Stdio MCP Server"
  }
};
