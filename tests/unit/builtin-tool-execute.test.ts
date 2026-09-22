import { describe, expect, test } from "vitest";

import type { FileBackedMemoryService } from "@/core/memory";
import { createAttemptCompleteTool } from "@/core/tools/builtins/attempt-complete";
import { createMemoryGetTool } from "@/core/tools/builtins/memory-get";
import { createMemoryIndexTool } from "@/core/tools/builtins/memory-index";
import { createMemoryStatusTool } from "@/core/tools/builtins/memory-status";
import type { ToolCallRecord } from "@/core/contracts";

function call(args: Record<string, unknown>): ToolCallRecord {
  return {
    arguments: args,
    createdAt: "2026-03-31T12:00:00.000Z",
    id: "tool-call.builtin.1",
    metadata: {},
    sessionId: "session.builtin.1",
    status: "running",
    toolId: "tool.builtin.test",
    toolName: "test",
    turnId: "turn.builtin.1",
    updatedAt: "2026-03-31T12:00:00.000Z"
  } as unknown as ToolCallRecord;
}

// `attempt_complete` is normally intercepted by the agent loop's completion
// gate and never executed, so its own execute path had no coverage at all. It
// still has to behave if a surface (tool.execute over the gateway, the SDK)
// invokes it directly.
describe("attempt_complete tool execute", () => {
  test("echoes the requested status and summary", async () => {
    const tool = createAttemptCompleteTool();

    const result = await tool.execute(call({ status: "success", summary: "17 * 23 = 391." }), {} as never);

    expect(result.result).toEqual({
      completionRequested: true,
      status: "success",
      summary: "17 * 23 = 391."
    });
  });

  test("defaults status and summary when the model omits them", async () => {
    const tool = createAttemptCompleteTool();

    const result = await tool.execute(call({}), {} as never);

    expect(result.result).toEqual({
      completionRequested: true,
      status: "success",
      summary: "Completion requested."
    });
  });
});

describe("memory tool execute paths", () => {
  test("memory_status reports what the memory service says", async () => {
    const status = { lastCompaction: null, sources: {} };
    const tool = createMemoryStatusTool({
      memoryService: { getMemoryStatus: async () => status } as unknown as FileBackedMemoryService
    });

    await expect(tool.execute(call({}), {} as never)).resolves.toEqual({ result: status });
  });

  test("memory_index returns the reindex outcome", async () => {
    const outcome = { documentCount: 12, indexedAt: "2026-03-31T12:00:00.000Z" };
    const tool = createMemoryIndexTool({
      memoryService: { reindexMemory: async () => outcome } as unknown as FileBackedMemoryService
    });

    await expect(tool.execute(call({}), {} as never)).resolves.toEqual({ result: outcome });
  });

  test("memory_get forwards the validated read window", async () => {
    const seen: unknown[] = [];
    const tool = createMemoryGetTool({
      memoryService: {
        getMemoryFile: async (input: unknown) => {
          seen.push(input);
          return { content: "remembered", path: "MEMORY.md" };
        }
      } as unknown as FileBackedMemoryService
    });

    const result = await tool.execute(call({ lineCount: 20, path: "MEMORY.md", startLine: 5 }), {} as never);

    expect(seen).toEqual([{ lineCount: 20, path: "MEMORY.md", startLine: 5 }]);
    expect(result.result).toEqual({ content: "remembered", path: "MEMORY.md" });
  });

  test("memory_get rejects arguments that do not match its schema", async () => {
    const tool = createMemoryGetTool({
      memoryService: { getMemoryFile: async () => ({}) } as unknown as FileBackedMemoryService
    });

    // A missing path, or a bogus extra key, must fail loudly rather than
    // silently reading something else.
    await expect(tool.execute(call({}), {} as never)).rejects.toThrow();
    await expect(
      tool.execute(call({ elsewhere: "../../etc/passwd", path: "MEMORY.md" }), {} as never)
    ).rejects.toThrow();
  });
});
