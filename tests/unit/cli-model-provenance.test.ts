import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatChatModelProvenance, mentionsChatModel } from "@/cli";
import { APP_CONFIG_FILE_NAME, DEFAULT_LM_STUDIO_MODEL, type LoadedAIAgentConfig } from "@/core";

/**
 * Builds only the slice of the loaded config the formatter reads. A real
 * `loadAIAgentConfig` would need a workspace on disk and tells us nothing extra
 * about the message.
 */
function buildLoaded(params: { globals: string[]; model: string; workspace: string | null }): LoadedAIAgentConfig {
  return {
    paths: { workspaceRoot: "/repo" },
    resolvedConfig: { runtime: { defaultModel: params.model } },
    sources: {
      config: { env: false, global: params.globals, workspace: params.workspace }
    }
  } as unknown as LoadedAIAgentConfig;
}

describe("chat model provenance", () => {
  it("calls out the built-in default, which is the confusing case", () => {
    // The failure this exists for: `aia` run outside a configured workspace
    // silently falls back to the default, so the provider's error names a model
    // the operator never chose and looks like their config was ignored.
    const message = formatChatModelProvenance(
      buildLoaded({ globals: [], model: DEFAULT_LM_STUDIO_MODEL, workspace: null })
    );

    expect(message).toContain(`"${DEFAULT_LM_STUDIO_MODEL}"`);
    expect(message).toContain("built-in default");
    expect(message).toContain(`no ${APP_CONFIG_FILE_NAME} found`);
    expect(message).toContain("/repo");
    expect(message).toContain("user-global config: none");
    expect(message).toContain("runtime.defaultModel");
  });

  it("names the files that did set the model", () => {
    const workspace = path.join("/repo", APP_CONFIG_FILE_NAME);
    // Uses the shipped default as its value on purpose: a configured model can
    // legitimately equal the default, and that must not be reported as "no
    // config file set this".
    const message = formatChatModelProvenance(
      buildLoaded({ globals: ["/home/u/.aia/config.jsonc"], model: DEFAULT_LM_STUDIO_MODEL, workspace })
    );

    expect(message).toContain(`"${DEFAULT_LM_STUDIO_MODEL}"`);
    expect(message).toContain(workspace);
    expect(message).toContain("/home/u/.aia/config.jsonc");
    // Not a default, so it must not accuse the operator of having no config.
    expect(message).not.toContain("built-in default");
  });

  it("recognizes a real provider model error and ignores unrelated ones", () => {
    // Verbatim from LM Studio when it refused to load the previous default.
    expect(
      mentionsChatModel(
        'Failed to load model "google/gemma-4-26b-a4b-qat". Error: Model loading was stopped due to insufficient system resources.'
      )
    ).toBe(true);
    expect(mentionsChatModel("The model does-not-exist was not found.")).toBe(true);
    expect(mentionsChatModel("fetch failed: ECONNREFUSED 127.0.0.1:1234")).toBe(false);
    expect(mentionsChatModel("Tool write_file was denied by policy.")).toBe(false);
  });
});
