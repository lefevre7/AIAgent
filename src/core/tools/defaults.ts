import { createToolApprovalDecider } from "@/core/approvals";
import { DEFAULT_APPROVAL_SETTINGS } from "@/core/config";
import type {
  BrowserAutomationService,
  ExternalAgentService,
  ImageService,
  ToolDefinition,
  ToolRegistry,
  VoiceService
} from "@/core/contracts";
import { createExternalAgentApprovalTargetResolver } from "@/core/external-agents";
import type { MCPManager } from "@/core/mcp";
import { createMcpExecutableToolRegistry } from "@/core/mcp";
import { createAskUserQuestionTool } from "@/core/tools/builtins/ask-user-question";
import { createAttemptCompleteTool } from "@/core/tools/builtins/attempt-complete";
import { createBrowserTools } from "@/core/tools/builtins/browser";
import { createChannelSendTool } from "@/core/tools/builtins/channel-send";
import { CommandRuntime } from "@/core/tools/builtins/command-runtime";
import { createCommandTools } from "@/core/tools/builtins/commands";
import { createExternalAgentTool } from "@/core/tools/builtins/external-agent";
import { createImageGenerateTool } from "@/core/tools/builtins/image";
import { createMemoryGetTool } from "@/core/tools/builtins/memory-get";
import { createMemoryIndexTool } from "@/core/tools/builtins/memory-index";
import { createMemorySearchTool } from "@/core/tools/builtins/memory-search";
import { createMemoryStatusTool } from "@/core/tools/builtins/memory-status";
import { createMemoryWriteTool } from "@/core/tools/builtins/memory-write";
import { createNotebookEditTool } from "@/core/tools/builtins/notebook";
import { createMcpReadResourceTool } from "@/core/tools/builtins/mcp-read-resource";
import { createMcpReadResourceTemplateTool } from "@/core/tools/builtins/mcp-read-resource-template";
import { createMcpSearchTool } from "@/core/tools/builtins/mcp-search";
import { createMcpStatusTool } from "@/core/tools/builtins/mcp-status";
import { createPdfReadTool } from "@/core/tools/builtins/pdf-read";
import { createSessionsSearchTool } from "@/core/tools/builtins/sessions-search";
import { createThinkTool } from "@/core/tools/builtins/think";
import { createToolSearchTool } from "@/core/tools/builtins/tool-search";
import { createViewImageTool } from "@/core/tools/builtins/view-image";
import { createUpdatePlanTool } from "@/core/tools/builtins/update-plan";
import { createVoiceTools } from "@/core/tools/builtins/voice";
import { createWebFetchTool } from "@/core/tools/builtins/web-fetch";
import { createWebSearchTool } from "@/core/tools/builtins/web-search";
import { createWorkspaceTools } from "@/core/tools/builtins/workspace";
import {
  combineToolRegistries,
  ToolRegistryBuilder
} from "@/core/tools/registry";
import { ToolRuntime } from "@/core/tools/runtime";
import type { ChannelService } from "@/core/channels";
import type { FileBackedMemoryService } from "@/core/memory";
import type { TaskStateService } from "@/core/plans";
import type { FileSessionStore } from "@/core/sessions";
import { WorkspaceMutationEngine } from "@/core/workspace";

// Core tools exposed to the model by default under the "lean" tools profile.
// Everything else stays registered and executable, and becomes model-visible
// through tool_search activation or tools.include config. Keeping this set
// small is a deliberate optimization for small local models: large tool
// catalogs measurably degrade tool-selection accuracy and burn context.
export const LEAN_TOOL_PROFILE_INVOCATION_NAMES: readonly string[] = [
  "apply_patch",
  "ask_user_question",
  "attempt_complete",
  "create_file",
  "edit_file",
  "grep_files",
  "list_files",
  "read_command_output",
  "read_file",
  "search_paths",
  "shell_command",
  "think",
  "tool_search",
  "update_plan",
  "web_fetch",
  "web_search"
];

export function resolveVisibleToolDefinitions(params: {
  // Extra invocation names to make visible under the lean profile beyond the
  // core set (e.g. "mcp_status" only when MCP servers are configured), so the
  // lean catalog stays minimal otherwise.
  alwaysInclude?: string[];
  registry: Pick<ToolRegistry, "listDefinitions">;
  toolsConfig: {
    exclude: string[];
    include: string[];
    profile: "full" | "lean";
  };
}): ToolDefinition[] {
  const excluded = new Set(params.toolsConfig.exclude);
  const all = params.registry.listDefinitions();

  if (params.toolsConfig.profile === "full") {
    return all.filter((definition) => !excluded.has(definition.invocationName));
  }

  const allowed = new Set([
    ...LEAN_TOOL_PROFILE_INVOCATION_NAMES,
    ...params.toolsConfig.include,
    ...(params.alwaysInclude ?? [])
  ]);
  return all.filter(
    (definition) =>
      allowed.has(definition.invocationName) &&
      !excluded.has(definition.invocationName)
  );
}

export function createDefaultToolRegistry(
  options: {
    browserService?: BrowserAutomationService;
    channelService?: ChannelService;
    commandRuntime?: CommandRuntime;
    externalAgentService?: ExternalAgentService;
    fetchImpl?: typeof fetch;
    imageService?: ImageService;
    mcpArtifactRoot?: string;
    mcpManager?: MCPManager;
    memoryService?: FileBackedMemoryService;
    sessions?: FileSessionStore;
    stateRoot?: string;
    taskStateService?: TaskStateService;
    voiceService?: VoiceService;
    workspaceEngine?: WorkspaceMutationEngine;
    workspaceRoot?: string;
  } = {}
) {
  const workspaceEngine =
    options.workspaceEngine ??
    (options.workspaceRoot
      ? new WorkspaceMutationEngine({
          allowArbitraryPaths: true,
          stateRoot: options.stateRoot,
          workspaceRoot: options.workspaceRoot
        })
      : undefined);
  const commandRuntime =
    options.commandRuntime ??
    (options.workspaceRoot && options.stateRoot
      ? new CommandRuntime({
          baseDirectory: options.workspaceRoot,
          stateRoot: options.stateRoot
        })
      : undefined);

  const builder = new ToolRegistryBuilder()
    .register(createAskUserQuestionTool())
    .register(createAttemptCompleteTool())
    .register(createPdfReadTool())
    .register(createThinkTool())
    .register(createToolSearchTool())
    .register(createViewImageTool())
    .register(
      createWebFetchTool({
        fetchImpl: options.fetchImpl
      })
    );

  if (options.taskStateService) {
    builder.register(
      createUpdatePlanTool({
        taskStateService: options.taskStateService
      })
    );
  }

  if (workspaceEngine) {
    for (const tool of createWorkspaceTools({ workspaceEngine })) {
      builder.register(tool);
    }
    builder.register(createNotebookEditTool({ workspaceEngine }));
  }

  if (commandRuntime) {
    for (const tool of createCommandTools({ commandRuntime })) {
      builder.register(tool);
    }
  }

  if (options.browserService) {
    for (const tool of createBrowserTools({
      browserService: options.browserService
    })) {
      builder.register(tool);
    }
  }

  if (options.externalAgentService) {
    builder.register(
      createExternalAgentTool({
        externalAgentService: options.externalAgentService
      })
    );
  }

  if (options.imageService) {
    builder.register(
      createImageGenerateTool({
        imageService: options.imageService
      })
    );
  }

  if (options.memoryService) {
    builder.register(
      createMemoryGetTool({
        memoryService: options.memoryService
      })
    );
    builder.register(
      createMemoryIndexTool({
        memoryService: options.memoryService
      })
    );
    builder.register(
      createMemorySearchTool({
        memoryService: options.memoryService
      })
    );
    builder.register(
      createMemoryStatusTool({
        memoryService: options.memoryService
      })
    );
    builder.register(
      createMemoryWriteTool({
        memoryService: options.memoryService
      })
    );
  }

  if (options.sessions) {
    builder.register(createSessionsSearchTool({ sessions: options.sessions }));
  }

  if (options.channelService) {
    builder.register(
      createChannelSendTool({ channelService: options.channelService })
    );
  }

  if (options.voiceService) {
    for (const tool of createVoiceTools({
      voiceService: options.voiceService
    })) {
      builder.register(tool);
    }
  }

  if (options.mcpManager) {
    builder.register(
      createWebSearchTool({
        mcpManager: options.mcpManager
      })
    );
    builder.register(
      createMcpSearchTool({
        mcpManager: options.mcpManager
      })
    );
    builder.register(
      createMcpStatusTool({
        mcpManager: options.mcpManager
      })
    );
    builder.register(
      createMcpReadResourceTool({
        mcpManager: options.mcpManager
      })
    );
    builder.register(
      createMcpReadResourceTemplateTool({
        mcpManager: options.mcpManager
      })
    );
  }

  const baseRegistry = builder.build();

  if (!options.mcpManager) {
    return baseRegistry;
  }

  return combineToolRegistries([
    baseRegistry,
    createMcpExecutableToolRegistry(options.mcpManager, {
      artifactRoot: options.mcpArtifactRoot
    })
  ]);
}

export function createDefaultToolRuntime(
  options: {
    browserService?: BrowserAutomationService;
    channelService?: ChannelService;
    commandRuntime?: CommandRuntime;
    externalAgentService?: ExternalAgentService;
    fetchImpl?: typeof fetch;
    imageService?: ImageService;
    mcpArtifactRoot?: string;
    mcpManager?: MCPManager;
    memoryService?: FileBackedMemoryService;
    sessions?: FileSessionStore;
    stateRoot?: string;
    taskStateService?: TaskStateService;
    voiceService?: VoiceService;
    workspaceEngine?: WorkspaceMutationEngine;
    workspaceRoot?: string;
  } = {}
) {
  return new ToolRuntime({
    approvalDecider: createToolApprovalDecider({
      resolveAdditionalTargets: options.externalAgentService
        ? createExternalAgentApprovalTargetResolver({
            service: options.externalAgentService
          })
        : undefined,
      settings: DEFAULT_APPROVAL_SETTINGS
    }),
    registry: createDefaultToolRegistry(options)
  });
}
