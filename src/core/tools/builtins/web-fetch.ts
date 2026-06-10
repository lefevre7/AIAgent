import { z } from "zod";

import type { ToolDefinition } from "@/core/contracts";
import { WebPageFetcher } from "@/core/research";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = z
  .object({
    maxChars: z.number().int().positive().max(100_000).optional(),
    query: z.string().min(1).max(500).optional(),
    url: z.string().min(1).max(4096)
  })
  .strict();

export function createWebFetchTool(options: { fetchImpl?: typeof fetch } = {}): RuntimeTool {
  const fetcher = new WebPageFetcher({
    fetchImpl: options.fetchImpl
  });

  return {
    definition: webFetchToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = inputSchema.parse(call.arguments as unknown);
      const result = await fetcher.fetch(input);
      const snippets = result.snippets.map((snippet) => ({
        kind: "markdown" as const,
        markdown: `> ${snippet}`
      }));

      return {
        citations: [
          {
            title: result.title ?? result.finalUrl,
            uri: result.finalUrl
          }
        ],
        display: [
          ...(result.title
            ? [
                {
                  kind: "status" as const,
                  state: "running" as const,
                  summary: `Fetched ${result.title}`
                }
              ]
            : []),
          ...snippets,
          {
            kind: "markdown" as const,
            markdown: result.contentMarkdown
          }
        ],
        result
      };
    }
  };
}

export const webFetchToolDefinition: ToolDefinition = {
  aliases: ["fetch_url", "fetch_web_page"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "web"
    },
    openWorldHint: true,
    readOnlyHint: true,
    title: "Web Fetch"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only performs read-only public web fetches.",
    examples: [
      "Fetch a specific documentation page before summarizing it.",
      "Pull the main content from a URL and optionally focus on a specific query."
    ],
    purpose: "Fetch a specific public web page, extract the main content, and convert it into markdown the model can read reliably.",
    sideEffectSummary: "Performs public network reads only.",
    whenNotToUse: [
      "Do not use this when you still need to discover relevant URLs; use web_search first.",
      "Do not use this for localhost or private-network URLs."
    ],
    whenToUse: [
      "Use when the user gives you an exact URL or the needed page is already known.",
      "Use after web_search to read the most relevant result in detail."
    ]
  },
  description: "Fetch the main content from a specific public web page and return a markdown-friendly extraction.",
  displayName: "Web Fetch",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      maxChars: {
        maximum: 100000,
        minimum: 1,
        type: "integer"
      },
      query: {
        type: "string"
      },
      url: {
        type: "string"
      }
    },
    required: ["url"],
    type: "object"
  },
  invocationName: "web_fetch",
  kind: "built_in",
  metadata: {},
  name: "web_fetch",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["fetch", "html", "markdown", "url", "web"],
  sideEffects: ["network_read"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.web_fetch",
  usageGuidance:
    "Use this for exact public URLs. It extracts readable markdown from the fetched page and can optionally focus on snippets relevant to a query.",
  version: "1.0.0"
};
