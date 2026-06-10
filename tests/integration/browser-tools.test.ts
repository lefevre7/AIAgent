import { describe, expect, test } from "vitest";

import {
  type BrowserAutomationService,
  createDefaultToolRegistry,
  sessionRecordSchema,
  ToolRuntime,
  toolCallRecordSchema,
  turnRecordSchema
} from "@/core";

describe("browser tools", () => {
  test("registers browser tools in the default registry and exposes them through tool search", () => {
    const registry = createDefaultToolRegistry({
      browserService: fakeBrowserService()
    });

    const matches = registry.searchDefinitions({
      kinds: ["browser"],
      limit: 20,
      query: "snapshot"
    });

    expect(matches.some((match) => match.definition.invocationName === "browser_snapshot")).toBe(true);
    expect(registry.getDefinition("browser_upload_file")?.kind).toBe("browser");
  });

  test("requests approval for mutating browser tools using the browser_action target", async () => {
    const runtime = new ToolRuntime({
      registry: createDefaultToolRegistry({
        browserService: fakeBrowserService()
      })
    });

    const result = await runtime.execute(
      createCall({
        arguments: {
          selector: "#dangerous"
        },
        id: "tool-call.browser.tools.approval",
        toolName: "browser_click"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(result.toolCall.status).toBe("awaiting_approval");
    expect(result.approvalRequest?.target.kind).toBe("browser_action");
  });

});

function fakeBrowserService(): BrowserAutomationService {
  return {
    click: async () =>
      browserPage({
        url: "https://example.com"
      }),
    closePage: async () => ({
      activePageId: null,
      closedPageId: "browser.page.1",
      pages: []
    }),
    dispose: async () => {},
    fill: async () =>
      browserPage({
        url: "https://example.com"
      }),
    listDownloads: async () => [],
    listPages: async () => ({
      activePageId: "browser.page.1",
      pages: [browserPage({ active: true, url: "https://example.com" })]
    }),
    navigate: async () =>
      browserPage({
        url: "https://example.com/next"
      }),
    openPage: async () => ({
      createdPage: true,
      navigated: true,
      page: browserPage({
        active: true,
        url: "https://example.com"
      })
    }),
    press: async () =>
      browserPage({
        url: "https://example.com"
      }),
    screenshot: async () => ({
      id: "artifact.browser.screenshot.1",
      kind: "image" as const,
      metadata: {},
      uri: "file:///tmp/browser.png"
    }),
    selectOptions: async () =>
      browserPage({
        url: "https://example.com"
      }),
    snapshot: async () => ({
      ariaSnapshot: '- heading "Runtime Browser"',
      elements: [
        {
          ref: "e1",
          tagName: "button",
          text: "Continue"
        }
      ],
      metadata: {},
      pageId: "browser.page.1",
      sessionId: "session.browser.tools.1",
      takenAt: "2026-03-27T12:00:00.000Z",
      title: "Runtime Browser",
      truncated: false,
      url: "https://example.com"
    }),
    type: async () =>
      browserPage({
        url: "https://example.com"
      }),
    upload: async () =>
      browserPage({
        url: "https://example.com"
      }),
    waitFor: async () =>
      browserPage({
        url: "https://example.com"
      })
  };
}

function browserPage(overrides: { active?: boolean; url: string }) {
  return {
    active: overrides.active ?? true,
    createdAt: "2026-03-27T12:00:00.000Z",
    id: "browser.page.1",
    metadata: {},
    sessionId: "session.browser.tools.1",
    title: "Runtime Browser",
    url: overrides.url
  };
}

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise browser tool coverage",
    id: "session.browser.tools.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Browser Tool Session",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.browser.tools.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.browser.tools.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.browser.tools.default",
    metadata: {},
    sessionId: "session.browser.tools.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolName: "browser_snapshot",
    turnId: "turn.browser.tools.1",
    ...overrides
  });
}
