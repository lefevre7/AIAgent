import { z } from "zod";

import type { JsonSchemaDocument, Message, ToolDefinition } from "@/core/contracts";
import type { FileSessionStore } from "@/core/sessions";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const sessionsSearchInputSchema = z
  .object({
    limit: z.number().int().positive().max(50).optional(),
    query: z.string().min(1).max(2000).optional()
  })
  .strict();

type SessionSearchHit = {
  goal: string;
  id: string;
  lastActiveAt: string;
  snippet?: string;
  status: string;
  title: string;
};

export function createSessionsSearchTool(params: { sessions: FileSessionStore }): RuntimeTool {
  return {
    definition: sessionsSearchToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = sessionsSearchInputSchema.parse(call.arguments as unknown);
      const limit = input.limit ?? 10;
      const query = input.query?.trim().toLowerCase();

      const sessions = await params.sessions.listSessions();
      const sorted = [...sessions].sort((left, right) =>
        (right.lastActiveAt ?? right.updatedAt).localeCompare(left.lastActiveAt ?? left.updatedAt)
      );

      const hits: SessionSearchHit[] = [];
      for (const session of sorted) {
        if (hits.length >= limit) {
          break;
        }

        if (!query) {
          hits.push(toHit(session));
          continue;
        }

        const fieldMatch = [session.title, session.goal].some((value) => value.toLowerCase().includes(query));
        if (fieldMatch) {
          hits.push(toHit(session));
          continue;
        }

        const snapshot = await params.sessions.getSessionSnapshot(session.id);
        const matchingText = (snapshot?.messages ?? [])
          .map((message) => extractMessageText(message))
          .find((text) => text.toLowerCase().includes(query));
        if (matchingText) {
          hits.push(toHit(session, buildSnippet(matchingText, query)));
        }
      }

      return {
        display: [
          {
            kind: "status",
            state: "searched",
            summary: query ? `Found ${hits.length} session(s) matching "${input.query}".` : `Listed ${hits.length} recent session(s).`
          }
        ],
        result: {
          query: query ?? null,
          sessions: hits,
          total: hits.length
        }
      };
    }
  };
}

function toHit(
  session: { goal: string; id: string; lastActiveAt: string; status: string; title: string },
  snippet?: string
): SessionSearchHit {
  return {
    goal: session.goal,
    id: session.id,
    lastActiveAt: session.lastActiveAt,
    status: session.status,
    title: session.title,
    ...(snippet ? { snippet } : {})
  };
}

function extractMessageText(message: Message): string {
  return message.parts
    .map((part) => {
      switch (part.kind) {
        case "markdown":
          return part.markdown;
        case "status":
          return part.summary;
        case "text":
          return part.text;
        default:
          return "";
      }
    })
    .filter((text) => text.trim().length > 0)
    .join(" ")
    .trim();
}

function buildSnippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + query.length + 120);
  return text.slice(start, end).replace(/\s+/gu, " ").trim();
}

const sessionsSearchOutputSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    query: { type: ["string", "null"] },
    sessions: {
      items: {
        additionalProperties: false,
        properties: {
          goal: { type: "string" },
          id: { type: "string" },
          lastActiveAt: { type: "string" },
          snippet: { type: "string" },
          status: { type: "string" },
          title: { type: "string" }
        },
        required: ["goal", "id", "lastActiveAt", "status", "title"],
        type: "object"
      },
      type: "array"
    },
    total: { type: "integer" }
  },
  required: ["query", "sessions", "total"],
  type: "object"
};

export const sessionsSearchToolDefinition: ToolDefinition = {
  aliases: ["list_sessions", "past_sessions"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "sessions"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Search Sessions"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads local session history.",
    examples: [
      "List recent sessions to find prior related work.",
      "Search past sessions for a topic before redoing analysis."
    ],
    purpose: "List or search prior sessions (by title, goal, or transcript text) and return summaries with snippets.",
    sideEffectSummary: "Reads local session history only.",
    whenNotToUse: [
      "Do not use it to read durable memory notes; use memory_search for that.",
      "Do not use it to read files; use read_file or grep_files."
    ],
    whenToUse: [
      "Use to recall what a previous session worked on.",
      "Use to find a related earlier session before starting similar work."
    ]
  },
  description:
    "List recent sessions or search prior sessions by title, goal, or transcript text. Returns session summaries and a matching snippet when a query is provided.",
  displayName: "Search Sessions",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: {
        description: "Maximum number of sessions to return (default 10).",
        type: "integer"
      },
      query: {
        description: "Optional text to match against session titles, goals, and transcripts.",
        type: "string"
      }
    },
    type: "object"
  },
  invocationName: "sessions_search",
  kind: "built_in",
  metadata: {},
  name: "sessions_search",
  outputKind: "json",
  outputSchema: sessionsSearchOutputSchema,
  retryable: true,
  searchTags: ["history", "past", "recall", "sessions", "search"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.sessions_search",
  usageGuidance:
    "Use this to recall prior sessions. Provide a query to search titles, goals, and transcripts, or omit it to list the most recent sessions. It is read-only.",
  version: "1.0.0"
};
