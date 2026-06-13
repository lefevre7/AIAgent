import { z } from "zod";

import {
  entityIdSchema,
  isoTimestampSchema,
  jsonValueSchema,
  metadataSchema,
  structuredErrorSchema,
  tagsSchema,
  uriSchema
} from "@/core/contracts/common";

export const mcpTransportTypeSchema = z.enum([
  "auto",
  "sse",
  "stdio",
  "streamable-http"
]);
export const mcpServerConnectionStateSchema = z.enum([
  "connected",
  "connecting",
  "degraded",
  "disabled",
  "failed"
]);
export const mcpCapabilityKindSchema = z.enum([
  "prompt",
  "resource",
  "resource_template",
  "server_template",
  "tool"
]);
export const mcpCapabilityAccessSchema = z.enum(["api_only", "model_and_api"]);
export const mcpImportFormatSchema = z.enum([
  "claude_desktop",
  "generic_mcp_servers_json",
  "roo_project"
]);
export const mcpSearchScopeSchema = z.enum(["connected", "templates"]);

export const mcpServerProvenanceSchema = z
  .object({
    importId: z.string().min(1).max(128).optional(),
    source: z.enum(["config", "import", "template"]),
    templateId: z.string().min(1).max(128).optional()
  })
  .strict();

export const mcpServerStatusSchema = z
  .object({
    capabilities: z
      .object({
        prompts: z.number().int().nonnegative().default(0),
        resourceTemplates: z.number().int().nonnegative().default(0),
        resources: z.number().int().nonnegative().default(0),
        tools: z.number().int().nonnegative().default(0)
      })
      .strict(),
    checkedAt: isoTimestampSchema,
    error: structuredErrorSchema.optional(),
    lastConnectedAt: isoTimestampSchema.optional(),
    serverName: z.string().min(1).max(128),
    state: mcpServerConnectionStateSchema,
    transport: mcpTransportTypeSchema
  })
  .strict();

export const mcpCapabilityBaseSchema = z
  .object({
    access: mcpCapabilityAccessSchema,
    annotations: metadataSchema.default({}),
    description: z.string().min(1).optional(),
    displayName: z.string().min(1).max(256),
    id: entityIdSchema,
    kind: mcpCapabilityKindSchema,
    metadata: metadataSchema.default({}),
    name: z.string().min(1).max(256),
    serverName: z.string().min(1).max(128).optional(),
    tags: tagsSchema.default([])
  })
  .strict();

export const mcpToolCapabilitySchema = mcpCapabilityBaseSchema
  .extend({
    access: z.literal("model_and_api"),
    execution: z
      .object({
        taskSupport: z.enum(["forbidden", "optional", "required"]).optional()
      })
      .strict()
      .default({}),
    inputSchema: z.record(z.string(), jsonValueSchema),
    invocationName: z.string().min(1).max(64),
    kind: z.literal("tool"),
    outputSchema: z.record(z.string(), jsonValueSchema).optional(),
    rawName: z.string().min(1).max(256)
  })
  .strict();

export const mcpResourceCapabilitySchema = mcpCapabilityBaseSchema
  .extend({
    access: z.literal("model_and_api"),
    kind: z.literal("resource"),
    mimeType: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(256).optional(),
    uri: uriSchema
  })
  .strict();

export const mcpResourceTemplateCapabilitySchema = mcpCapabilityBaseSchema
  .extend({
    access: z.literal("model_and_api"),
    kind: z.literal("resource_template"),
    mimeType: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(256).optional(),
    uriTemplate: z.string().min(1).max(4096)
  })
  .strict();

export const mcpPromptArgumentSchema = z
  .object({
    description: z.string().min(1).optional(),
    name: z.string().min(1).max(128),
    required: z.boolean().optional()
  })
  .strict();

export const mcpPromptCapabilitySchema = mcpCapabilityBaseSchema
  .extend({
    access: z.literal("api_only"),
    arguments: z.array(mcpPromptArgumentSchema).max(64).default([]),
    kind: z.literal("prompt"),
    title: z.string().min(1).max(256).optional()
  })
  .strict();

export const mcpTemplateBootstrapStepSchema = z
  .object({
    args: z.array(z.string().min(1)).max(64).default([]),
    command: z.string().min(1),
    notes: z.string().min(1).max(2000).optional()
  })
  .strict();

export const mcpServerTemplateCapabilitySchema = mcpCapabilityBaseSchema
  .extend({
    access: z.literal("api_only"),
    bootstrap: z.array(mcpTemplateBootstrapStepSchema).max(16).default([]),
    kind: z.literal("server_template"),
    marketplace: z.boolean().default(false),
    source: z.enum(["built_in", "config"]),
    title: z.string().min(1).max(256).optional(),
    transport: mcpTransportTypeSchema
  })
  .strict();

export const mcpCapabilitySchema = z.discriminatedUnion("kind", [
  mcpPromptCapabilitySchema,
  mcpResourceCapabilitySchema,
  mcpResourceTemplateCapabilitySchema,
  mcpServerTemplateCapabilitySchema,
  mcpToolCapabilitySchema
]);

export const mcpCapabilitySearchQuerySchema = z
  .object({
    kinds: z.array(mcpCapabilityKindSchema).max(16).optional(),
    limit: z.number().int().positive().max(100).default(10),
    query: z.string().min(1).max(500).optional(),
    scopes: z.array(mcpSearchScopeSchema).max(4).optional(),
    serverNames: z.array(z.string().min(1).max(128)).max(64).optional()
  })
  .strict();

export const mcpCapabilitySearchMatchSchema = z
  .object({
    capability: mcpCapabilitySchema,
    matchedOn: z.array(z.string().min(1).max(128)).max(16).default([]),
    score: z.number().nonnegative()
  })
  .strict();

export const mcpPromptResultSchema = z
  .object({
    description: z.string().min(1).optional(),
    messages: z.array(z.record(z.string(), jsonValueSchema)).default([])
  })
  .strict();

export const mcpResourceReadResultSchema = z
  .object({
    contents: z.array(z.record(z.string(), jsonValueSchema)).default([]),
    uri: uriSchema
  })
  .strict();

export const mcpManagerHealthSchema = z
  .object({
    checkedAt: isoTimestampSchema,
    imports: z.number().int().nonnegative(),
    lastRefreshAt: isoTimestampSchema.optional(),
    servers: z.array(mcpServerStatusSchema),
    templates: z.number().int().nonnegative()
  })
  .strict();

// Operator/agent-facing summary of a configured MCP server: its connection
// state and the tools it currently exposes. Failed/disabled servers are
// included (with their error) so "what MCP servers do you have?" is answerable
// even when a server never connected.
export const mcpServerSummarySchema = z
  .object({
    capabilities: mcpServerStatusSchema.shape.capabilities,
    error: z.string().min(1).optional(),
    lastConnectedAt: isoTimestampSchema.optional(),
    serverName: z.string().min(1).max(128),
    state: mcpServerConnectionStateSchema,
    tools: z.array(
      z
        .object({
          description: z.string().min(1).optional(),
          invocationName: z.string().min(1),
          name: z.string().min(1)
        })
        .strict()
    ),
    transport: mcpTransportTypeSchema
  })
  .strict();

export type MCPCapability = z.infer<typeof mcpCapabilitySchema>;
export type MCPCapabilityAccess = z.infer<typeof mcpCapabilityAccessSchema>;
export type MCPCapabilityKind = z.infer<typeof mcpCapabilityKindSchema>;
export type MCPCapabilitySearchMatch = z.infer<
  typeof mcpCapabilitySearchMatchSchema
>;
export type MCPCapabilitySearchQuery = z.infer<
  typeof mcpCapabilitySearchQuerySchema
>;
export type MCPImportFormat = z.infer<typeof mcpImportFormatSchema>;
export type MCPManagerHealth = z.infer<typeof mcpManagerHealthSchema>;
export type MCPPromptResult = z.infer<typeof mcpPromptResultSchema>;
export type MCPResourceReadResult = z.infer<typeof mcpResourceReadResultSchema>;
export type MCPServerConnectionState = z.infer<
  typeof mcpServerConnectionStateSchema
>;
export type MCPServerProvenance = z.infer<typeof mcpServerProvenanceSchema>;
export type MCPServerStatus = z.infer<typeof mcpServerStatusSchema>;
export type MCPServerSummary = z.infer<typeof mcpServerSummarySchema>;
export type MCPServerTemplateCapability = z.infer<
  typeof mcpServerTemplateCapabilitySchema
>;
export type MCPTemplateBootstrapStep = z.infer<
  typeof mcpTemplateBootstrapStepSchema
>;
export type MCPToolCapability = z.infer<typeof mcpToolCapabilitySchema>;
export type MCPTransportType = z.infer<typeof mcpTransportTypeSchema>;
