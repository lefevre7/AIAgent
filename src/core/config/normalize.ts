import path from "node:path";

import type { AppConfigFragment } from "@/core/config/schema";
import { resolveAbsolutePath } from "@/core/config/paths";

export function normalizeConfigFragmentPaths<T extends AppConfigFragment>(fragment: T, baseDirectory: string): T {
  const next = structuredClone(fragment) as T;

  if (next.memory) {
    resolvePathField(next.memory, "workspaceRoot", baseDirectory);
    resolvePathField(next.memory, "userGlobalRoot", baseDirectory);
    resolvePathField(next.memory, "stateRoot", baseDirectory);
    resolvePathField(next.memory, "chatSessionRoot", baseDirectory);
    resolvePathField(next.memory, "sqlitePath", baseDirectory);
  }

  if (next.browser) {
    resolvePathField(next.browser, "artifactRoot", baseDirectory);
  }

  if (next.image) {
    resolvePathField(next.image, "artifactRoot", baseDirectory);
  }

  if (next.voice) {
    resolvePathField(next.voice, "artifactRoot", baseDirectory);
  }

  if (next.externalAgents) {
    resolvePathField(next.externalAgents, "stateRoot", baseDirectory);
    for (const agent of Object.values(next.externalAgents.agents ?? {})) {
      if (!agent) {
        continue;
      }
      resolvePathField(agent, "cwd", baseDirectory);
    }
  }

  if (next.channels?.whatsapp) {
    resolvePathField(next.channels.whatsapp, "sessionDirectory", baseDirectory);
  }

  if (next.providers?.imageProviders) {
    for (const provider of Object.values(next.providers.imageProviders)) {
      if (provider) {
        resolvePathField(provider, "workflowPath", baseDirectory);
        if (provider.workflowPaths) {
          resolvePathField(provider.workflowPaths, "textToImage", baseDirectory);
          resolvePathField(provider.workflowPaths, "imageToImage", baseDirectory);
          resolvePathField(provider.workflowPaths, "inpaint", baseDirectory);
        }
      }
    }
  }

  if (next.secrets?.providers) {
    for (const provider of Object.values(next.secrets.providers)) {
      if (!provider) {
        continue;
      }
      if (provider.source === "file") {
        provider.path = resolveAbsolutePath(provider.path, baseDirectory);
      }
      if (provider.source === "exec") {
        provider.command = resolveAbsolutePath(provider.command, baseDirectory);
      }
    }
  }

  if (next.mcp?.imports) {
    for (const entry of Object.values(next.mcp.imports)) {
      if (!entry) {
        continue;
      }
      entry.path = resolveAbsolutePath(entry.path, path.resolve(baseDirectory));
    }
  }

  if (next.mcp?.servers) {
    for (const server of Object.values(next.mcp.servers)) {
      if (!server) {
        continue;
      }
      if (server.type === "stdio") {
        resolvePathField(server, "cwd", baseDirectory);
      }
    }
  }

  if (next.mcp?.templates) {
    for (const template of Object.values(next.mcp.templates)) {
      if (!template) {
        continue;
      }
      if (template.server.type === "stdio") {
        resolvePathField(template.server, "cwd", baseDirectory);
      }
    }
  }

  return next;
}

function resolvePathField(target: Record<string, unknown>, key: string, baseDirectory: string): void {
  const value = target[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return;
  }
  target[key] = resolveAbsolutePath(value, path.resolve(baseDirectory));
}
