import path from "node:path";
import fs from "node:fs/promises";

import { afterEach, describe, expect } from "vitest";

import {
  createDefaultToolRegistry,
  createPlaywrightBrowserAutomationService,
  createToolApprovalDecider,
  sessionRecordSchema,
  ToolRuntime,
  toolCallRecordSchema,
  turnRecordSchema,
  type ApprovalSettings,
  type PlaywrightBrowserAutomationService
} from "@/core";
import { createLiveTestHarness, envFlag } from "./helpers";

const { createTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_BROWSER_TESTS"),
  prefix: "aiagent-live-browser-"
});

describe("browser automation service (live)", () => {
  const services: PlaywrightBrowserAutomationService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.dispose()));
  });

  liveTest("manages page lifecycle, snapshots, uploads, screenshots, downloads, and closure", async () => {
    const root = await createTempRoot();
    const uploadPath = path.join(root, "sample.txt");
    await fs.writeFile(uploadPath, "sample upload payload", "utf8");

    const service = createPlaywrightBrowserAutomationService({
      actionTimeoutMs: 5_000,
      artifactRoot: path.join(root, ".aia", "browser"),
      headless: true,
      navigationTimeoutMs: 5_000
    });
    services.push(service);

    const opened = await service.openPage({
      sessionId: "session.browser.service.1",
      url: createBrowserHarnessDataUrl()
    });
    expect(opened.createdPage).toBe(true);
    expect(opened.page.url.startsWith("data:text/html")).toBe(true);

    const snapshot = await service.snapshot({
      sessionId: "session.browser.service.1"
    });
    expect(snapshot.title).toBe("Browser Harness");
    const incrementRef = snapshot.elements.find((element) => element.text?.includes("Increment"));
    expect(incrementRef?.ref).toBeTruthy();

    await service.click({
      ref: incrementRef?.ref,
      sessionId: "session.browser.service.1"
    });
    await service.waitFor({
      sessionId: "session.browser.service.1",
      text: "Ready to continue",
      timeoutMs: 5_000
    });

    await service.fill({
      selector: "#name",
      sessionId: "session.browser.service.1",
      text: "AIAgent"
    });
    await service.type({
      selector: "#command",
      sessionId: "session.browser.service.1",
      text: "typed value"
    });
    await service.press({
      key: "Enter",
      selector: "#command",
      sessionId: "session.browser.service.1"
    });
    await service.waitFor({
      sessionId: "session.browser.service.1",
      text: "keyboard submitted",
      timeoutMs: 5_000
    });

    await service.selectOptions({
      selector: "#color",
      sessionId: "session.browser.service.1",
      values: ["Blue"]
    });
    await service.waitFor({
      sessionId: "session.browser.service.1",
      text: "color:blue",
      timeoutMs: 5_000
    });

    await service.upload({
      paths: [uploadPath],
      selector: "#upload",
      sessionId: "session.browser.service.1"
    });
    await service.waitFor({
      sessionId: "session.browser.service.1",
      text: "sample.txt",
      timeoutMs: 5_000
    });

    const screenshot = await service.screenshot({
      sessionId: "session.browser.service.1"
    });
    expect(screenshot.kind).toBe("image");
    expect(screenshot.uri).toContain(".png");
    await expect(fs.access(new URL(screenshot.uri))).resolves.toBeUndefined();

    await service.click({
      selector: "#download",
      sessionId: "session.browser.service.1"
    });
    const downloads = await service.listDownloads({
      sessionId: "session.browser.service.1"
    });
    expect(downloads.some((download) => download.status === "succeeded")).toBe(true);
    const completed = downloads.find((download) => download.status === "succeeded");
    expect(completed?.artifact?.uri).toBeTruthy();
    if (completed?.artifact?.uri) {
      await expect(fs.access(new URL(completed.artifact.uri))).resolves.toBeUndefined();
    }

    const pages = await service.listPages("session.browser.service.1");
    expect(pages.pages).toHaveLength(1);

    const closed = await service.closePage({
      sessionId: "session.browser.service.1"
    });
    expect(closed.closedPageId).toBe(opened.page.id);
    expect(closed.pages).toHaveLength(0);
  });

  liveTest("executes browser_open and browser_snapshot through the runtime when browser actions are allowed", async () => {
    const root = await createTempRoot();
    const service = createPlaywrightBrowserAutomationService({
      artifactRoot: path.join(root, ".aia", "browser"),
      headless: true
    });
    services.push(service);

    const settings: ApprovalSettings = {
      configVersion: 1,
      defaultMode: "ask",
      rules: [
        {
          id: "rule.browser.allow",
          mode: "allow",
          pattern: "^browser_",
          targetKind: "browser_action"
        }
      ]
    };

    const runtime = new ToolRuntime({
      approvalDecider: createToolApprovalDecider({
        settings
      }),
      registry: createDefaultToolRegistry({
        browserService: service
      })
    });

    const openResult = await runtime.execute(
      createRuntimeCall({
        arguments: {
          url: createRuntimeBrowserDataUrl()
        },
        id: "tool-call.browser.runtime.open",
        toolName: "browser_open"
      }),
      {
        session: buildRuntimeSession(),
        turn: buildRuntimeTurn()
      }
    );

    expect(openResult.toolCall.status).toBe("succeeded");
    expect(openResult.toolCall.result).toMatchObject({
      createdPage: true,
      page: {
        title: "Runtime Browser"
      }
    });

    const snapshotResult = await runtime.execute(
      createRuntimeCall({
        id: "tool-call.browser.runtime.snapshot",
        toolName: "browser_snapshot"
      }),
      {
        session: buildRuntimeSession(),
        turn: buildRuntimeTurn()
      }
    );

    expect(snapshotResult.toolCall.status).toBe("succeeded");
    expect(snapshotResult.toolCall.result).toMatchObject({
      title: "Runtime Browser"
    });
    expect(snapshotResult.resultMessage?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "markdown"
        })
      ])
    );
  });
});

function createBrowserHarnessDataUrl(): string {
  const html = `<!doctype html>
    <html>
      <head>
        <title>Browser Harness</title>
      </head>
      <body>
        <main>
          <h1>Browser Harness</h1>
          <button id="increment" type="button">Increment</button>
          <div id="status">Waiting</div>
          <div id="count">0</div>

          <label for="name">Name</label>
          <input id="name" name="name" type="text" />

          <label for="command">Command</label>
          <input id="command" name="command" type="text" />
          <div id="key-status">idle</div>

          <label for="color">Color</label>
          <select id="color" name="color">
            <option value="red">Red</option>
            <option value="blue">Blue</option>
          </select>
          <div id="color-status">color:none</div>

          <input id="upload" type="file" />
          <div id="upload-status">no file</div>

          <a id="download" href="data:text/plain,downloaded%20report" download="report.txt">Download report</a>
        </main>
        <script>
          const increment = document.getElementById("increment");
          const status = document.getElementById("status");
          const count = document.getElementById("count");
          increment.addEventListener("click", () => {
            count.textContent = String(Number(count.textContent || "0") + 1);
            setTimeout(() => {
              status.textContent = "Ready to continue";
            }, 75);
          });

          document.getElementById("command").addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              document.getElementById("key-status").textContent = "keyboard submitted";
            }
          });

          document.getElementById("color").addEventListener("change", (event) => {
            document.getElementById("color-status").textContent = "color:" + event.target.value;
          });

          document.getElementById("upload").addEventListener("change", (event) => {
            const file = event.target.files && event.target.files[0];
            document.getElementById("upload-status").textContent = file ? file.name : "no file";
          });
        </script>
      </body>
    </html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createRuntimeBrowserDataUrl(): string {
  const html = `<!doctype html>
    <html>
      <head><title>Runtime Browser</title></head>
      <body>
        <main>
          <h1>Runtime Browser</h1>
          <button id="continue">Continue</button>
        </main>
      </body>
    </html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function buildRuntimeSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise browser runtime coverage",
    id: "session.browser.runtime.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Browser Runtime Session",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildRuntimeTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.browser.runtime.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.browser.runtime.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createRuntimeCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.browser.runtime.default",
    metadata: {},
    sessionId: "session.browser.runtime.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolName: "browser_snapshot",
    turnId: "turn.browser.runtime.1",
    ...overrides
  });
}
