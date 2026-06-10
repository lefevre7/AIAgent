import { describe, expect, test } from "vitest";

import { runCodingTaskExample } from "../../examples/coding-task";
import { runMemorySkillsMcpTaskExample } from "../../examples/memory-skills-mcp-task";
import { runResearchWebTaskExample } from "../../examples/research-web-task";

describe("examples", () => {
  test("coding task example exercises prompt-pack and task-state updates", async () => {
    const result = await runCodingTaskExample();

    expect(result.runStatus).toBe("completed");
    expect(result.taskSummary).toContain("shared runtime");
    expect(result.toolCalls).toEqual(expect.arrayContaining(["update_plan"]));
    expect(result.promptPreview).toContain("Example Instructions");
  });

  test("research/web example exercises web_fetch without live network credentials", async () => {
    const result = await runResearchWebTaskExample();

    expect(result.runStatus).toBe("completed");
    expect(result.fetchedTitle).toBe("Runtime Surfaces");
    expect(result.toolCalls).toEqual(expect.arrayContaining(["web_fetch"]));
    expect(result.assistantSummaries.join("\n")).toContain("shared runtime exposes CLI, SDK, web, and gateway");
  });

  test("memory/skills/MCP example exercises durable memory, skill discovery, and MCP tools", async () => {
    const result = await runMemorySkillsMcpTaskExample();

    expect(result.runStatus).toBe("completed");
    expect(result.toolCalls).toEqual(expect.arrayContaining(["memory_search", "mcp_search", "mcp_docs_docs_lookup"]));
    expect(result.promptPreview).toContain("release-readiness");
  });
});
