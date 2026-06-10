import type { JsonValue, ToolDefinition } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp/manager";
import type { MCPToolCapability } from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";
import type { ExecutableToolRegistry } from "@/core/tools/registry";
import { createExecutableToolRegistry } from "@/core/tools/registry";

export function createMcpRuntimeTools(manager: MCPManager): RuntimeTool[] {
  return manager.getToolCapabilities().map((capability) => createMcpRuntimeTool(manager, capability));
}

export function createMcpExecutableToolRegistry(manager: MCPManager): ExecutableToolRegistry {
  return new DynamicMcpToolRegistry(manager);
}

export function createMcpRuntimeTool(manager: MCPManager, capability: MCPToolCapability): RuntimeTool {
  return {
    definition: buildMcpToolDefinition(capability),
    async execute(call): Promise<RuntimeToolResult> {
      const result = await manager.callTool(capability.serverName ?? "", capability.invocationName, call.arguments);
      const content = Array.isArray(result.content) ? result.content : [];
      const textParts = content.flatMap((item) => {
        if (typeof item !== "object" || item === null || item.type !== "text" || typeof item.text !== "string") {
          return [];
        }
        return [
          {
            kind: "text" as const,
            text: item.text
          }
        ];
      });

      return {
        display: textParts,
        metadata: {
          isError: result.isError === true,
          rawContent: content
        },
        result: {
          content,
          isError: result.isError === true,
          structuredContent: toJsonCompatibleValue(result.structuredContent) ?? null
        }
      };
    }
  };
}

function buildMcpToolDefinition(capability: MCPToolCapability): ToolDefinition {
  const readOnly = capability.annotations.readOnlyHint === true;
  const destructive = capability.annotations.destructiveHint === true;
  const openWorld = capability.annotations.openWorldHint === true;

  return {
    aliases: [],
    annotations: {
      destructiveHint: destructive,
      idempotentHint: capability.annotations.idempotentHint === true,
      meta: capability.metadata,
      openWorldHint: openWorld,
      readOnlyHint: readOnly,
      title: capability.displayName
    },
    approvalMode: readOnly ? "never" : "ask",
    descriptor: {
      approvalNotes: readOnly
        ? `No approval is required because ${capability.displayName} is marked read-only by the MCP server.`
        : `Approval is required because ${capability.displayName} can trigger MCP-side effects or remote mutations.`,
      examples: [
        `Use when the MCP server "${capability.serverName}" exposes a specialized capability you cannot satisfy with built-in tools.`,
        `Prefer this when ${capability.displayName} is the canonical action provided by the connected MCP server.`
      ],
      purpose:
        capability.description ??
        `Call the MCP tool "${capability.name}" from server "${capability.serverName}" and return its structured result.`,
      sideEffectSummary: readOnly
        ? "This MCP tool is marked read-only by the server."
        : "This MCP tool can perform side effects outside the local built-in runtime.",
      whenNotToUse: [
        "Do not use this when a safer built-in read or edit tool already covers the same task.",
        "Do not guess the arguments; inspect the MCP capability catalog first if the schema is unclear."
      ],
      whenToUse: [
        `Use when the connected MCP server "${capability.serverName}" provides the best specialized implementation for this task.`,
        "Use after confirming the tool schema and approval expectations match the requested action."
      ]
    },
    description:
      capability.description ??
      `Call the MCP tool "${capability.name}" on server "${capability.serverName}".`,
    displayName: capability.displayName,
    execution: {
      inputMode: "json",
      resumable: capability.execution.taskSupport === "required" || capability.execution.taskSupport === "optional",
      taskSupport: capability.execution.taskSupport ?? "forbidden"
    },
    idempotent: capability.annotations.idempotentHint === true,
    inputSchema: capability.inputSchema,
    invocationName: capability.invocationName,
    kind: "mcp",
    metadata: capability.metadata,
    name: `${capability.serverName}.${capability.rawName}`,
    outputKind: "json",
    outputSchema: capability.outputSchema,
    retryable: true,
    searchTags: capability.tags,
    sideEffects: resolveSideEffects({ destructive, openWorld, readOnly }),
    source: {
      displayName: capability.serverName,
      kind: "mcp",
      serverName: capability.serverName
    },
    streamingMode: "none",
    toolId: capability.id,
    usageGuidance:
      "Use this only after confirming the MCP server is connected and this tool is the best fit. Prefer built-in tools first when they offer the same capability with better local guarantees.",
    version: "1.0.0"
  };
}

function resolveSideEffects(params: {
  destructive: boolean;
  openWorld: boolean;
  readOnly: boolean;
}): ToolDefinition["sideEffects"] {
  if (params.readOnly) {
    return params.openWorld ? ["network_read"] : ["none"];
  }
  if (params.destructive) {
    return ["remote_mutation"];
  }
  return params.openWorld ? ["network_write"] : ["remote_mutation"];
}

function toJsonCompatibleValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

class DynamicMcpToolRegistry implements ExecutableToolRegistry {
  constructor(private readonly manager: MCPManager) {}

  getDefinition(toolName: string): ToolDefinition | null {
    return this.snapshot().getDefinition(toolName);
  }

  getTool(toolName: string): RuntimeTool | null {
    return this.snapshot().getTool(toolName);
  }

  listDefinitions(): ToolDefinition[] {
    return this.snapshot().listDefinitions();
  }

  searchDefinitions(query: Parameters<ExecutableToolRegistry["searchDefinitions"]>[0]) {
    return this.snapshot().searchDefinitions(query);
  }

  private snapshot(): ExecutableToolRegistry {
    return createExecutableToolRegistry(createMcpRuntimeTools(this.manager));
  }
}
