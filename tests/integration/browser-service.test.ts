import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

// A self-contained fake of the slice of Playwright the service uses. The real
// driver is exercised by the opt-in live suite; here we cover the orchestration
// logic deterministically without launching Chromium.
vi.mock("playwright", () => {
  const pages: FakePage[] = [];
  let launchError: Error | null = null;

  type FakePage = {
    __emit: (event: string, arg?: unknown) => void;
    close: (opts?: unknown) => Promise<void>;
    evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
    getByText: () => FakeLocator;
    isClosed: () => boolean;
    keyboard: { press: (key: string) => Promise<void> };
    locator: (selector: string) => FakeLocator;
    on: (event: string, cb: (arg?: unknown) => void) => void;
    screenshot: (opts: { path: string }) => Promise<void>;
    goto: (url: string) => Promise<void>;
    title: () => Promise<string>;
    url: () => string;
    waitForLoadState: () => Promise<void>;
    waitForURL: () => Promise<void>;
  };
  type FakeLocator = {
    ariaSnapshot: () => Promise<string>;
    click: () => Promise<void>;
    dblclick: () => Promise<void>;
    evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
    fill: () => Promise<void>;
    first: () => FakeLocator;
    press: () => Promise<void>;
    pressSequentially: () => Promise<void>;
    screenshot: (opts: { path: string }) => Promise<void>;
    selectOption: () => Promise<void>;
    setInputFiles: () => Promise<void>;
    waitFor: () => Promise<void>;
  };

  async function writePng(filePath: string): Promise<void> {
    const fsmod = await import("node:fs");
    fsmod.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  function makeLocator(): FakeLocator {
    const locator: FakeLocator = {
      ariaSnapshot: async () => '- button "Go"',
      click: async () => undefined,
      dblclick: async () => undefined,
      evaluate: async (_fn, arg) => (Array.isArray(arg) ? Array.from(new Set(arg)) : arg),
      fill: async () => undefined,
      first: () => locator,
      press: async () => undefined,
      pressSequentially: async () => undefined,
      screenshot: async (opts) => writePng(opts.path),
      selectOption: async () => undefined,
      setInputFiles: async () => undefined,
      waitFor: async () => undefined
    };
    return locator;
  }

  function makePage(): FakePage {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    let closed = false;
    let currentUrl = "about:blank";
    const page: FakePage = {
      __emit: (event, arg) => handlers[event]?.(arg),
      close: async () => {
        closed = true;
        handlers.close?.();
      },
      evaluate: async (_fn, arg) => {
        if (typeof arg === "string") {
          return false;
        }
        return {
          elements: [{ locatorHint: "#go", ref: "e1", tagName: "button", text: "Go" }],
          textExcerpt: "body text",
          title: "Example Title",
          truncated: false,
          url: currentUrl
        };
      },
      getByText: () => makeLocator(),
      goto: async (url: string) => {
        currentUrl = url;
      },
      isClosed: () => closed,
      keyboard: { press: async () => undefined },
      locator: () => makeLocator(),
      on: (event, cb) => {
        handlers[event] = cb;
      },
      screenshot: async (opts) => writePng(opts.path),
      title: async () => "Example Title",
      url: () => currentUrl,
      waitForLoadState: async () => undefined,
      waitForURL: async () => undefined
    };
    pages.push(page);
    return page;
  }

  function makeContext() {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    return {
      __emit: (event: string, arg?: unknown) => handlers[event]?.(arg),
      close: async () => undefined,
      newPage: async () => makePage(),
      on: (event: string, cb: (arg?: unknown) => void) => {
        handlers[event] = cb;
      },
      setDefaultNavigationTimeout: () => undefined,
      setDefaultTimeout: () => undefined
    };
  }

  return {
    chromium: {
      __pages: pages,
      __setLaunchError: (error: Error | null) => {
        launchError = error;
      },
      launch: vi.fn(async () => {
        if (launchError) {
          throw launchError;
        }
        return { close: async () => undefined, newContext: async () => makeContext() };
      })
    }
  };
});

import { chromium } from "playwright";
import { createPlaywrightBrowserAutomationService } from "@/core/browser/service";

const chromiumMock = chromium as unknown as {
  __pages: Array<{ __emit: (event: string, arg?: unknown) => void }>;
  __setLaunchError: (error: Error | null) => void;
};

const tempRoots: string[] = [];

afterEach(async () => {
  chromiumMock.__setLaunchError(null);
  chromiumMock.__pages.length = 0;
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function createService() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-browser-svc-"));
  tempRoots.push(root);
  return createPlaywrightBrowserAutomationService({ artifactRoot: root, headless: true });
}

const SESSION = "session.browser.1";

describe("PlaywrightBrowserAutomationService", () => {
  test("opens, navigates, lists, snapshots, and serializes pages", async () => {
    const service = await createService();

    const opened = await service.openPage({ sessionId: SESSION, url: "https://example.com" });
    expect(opened.createdPage).toBe(true);
    expect(opened.navigated).toBe(true);
    expect(opened.page.url).toBe("https://example.com/");

    const reused = await service.openPage({ sessionId: SESSION });
    expect(reused.createdPage).toBe(false);

    const listed = await service.listPages(SESSION);
    expect(listed.pages.length).toBe(1);
    expect(listed.activePageId).toBe(opened.page.id);

    const navigated = await service.navigate({ sessionId: SESSION, url: "https://example.com/next" });
    expect(navigated.url).toBe("https://example.com/next");

    const snapshot = await service.snapshot({ sessionId: SESSION });
    expect(snapshot.elements[0]?.ref).toBe("e1");
    expect(snapshot.ariaSnapshot).toContain("button");

    await service.dispose();
  });

  test("captures page and element screenshots as artifacts", async () => {
    const service = await createService();
    await service.openPage({ sessionId: SESSION, url: "https://example.com" });

    const pageShot = await service.screenshot({ sessionId: SESSION });
    expect(pageShot.kind).toBe("image");
    expect(pageShot.mediaType).toBe("image/png");

    const elementShot = await service.screenshot({ imageType: "jpeg", selector: "#go", sessionId: SESSION });
    expect(elementShot.mediaType).toBe("image/jpeg");

    await service.dispose();
  });

  test("performs pointer, text, selection, key, upload, and wait actions", async () => {
    const service = await createService();
    await service.openPage({ sessionId: SESSION, url: "https://example.com" });

    await expect(service.click({ doubleClick: true, selector: "#go", sessionId: SESSION })).resolves.toMatchObject({ id: expect.any(String) });
    await expect(service.click({ ref: "e1", sessionId: SESSION })).resolves.toBeTruthy();
    await expect(service.fill({ selector: "#in", sessionId: SESSION, submit: true, text: "hi" })).resolves.toBeTruthy();
    await expect(service.type({ delayMs: 1, selector: "#in", sessionId: SESSION, text: "yo" })).resolves.toBeTruthy();
    await expect(service.selectOptions({ selector: "#sel", sessionId: SESSION, values: ["a", "a", "b"] })).resolves.toBeTruthy();
    await expect(service.press({ key: "Enter", selector: "#go", sessionId: SESSION })).resolves.toBeTruthy();
    await expect(service.press({ key: "Escape", sessionId: SESSION })).resolves.toBeTruthy();
    await expect(service.upload({ paths: ["/tmp/a.txt"], selector: "#file", sessionId: SESSION })).resolves.toBeTruthy();

    await expect(service.waitFor({ sessionId: SESSION, timeMs: 1 })).resolves.toBeTruthy();
    await expect(service.waitFor({ sessionId: SESSION, url: "https://example.com/**" })).resolves.toBeTruthy();
    await expect(service.waitFor({ sessionId: SESSION, text: "Go" })).resolves.toBeTruthy();
    await expect(service.waitFor({ sessionId: SESSION, textGone: "Spinner" })).resolves.toBeTruthy();
    await expect(service.waitFor({ selector: "#go", sessionId: SESSION })).resolves.toBeTruthy();

    await service.dispose();
  });

  test("captures downloads triggered on a page", async () => {
    const service = await createService();
    await service.openPage({ sessionId: SESSION, url: "https://example.com" });

    const fakePage = chromiumMock.__pages[chromiumMock.__pages.length - 1];
    fakePage?.__emit("download", {
      saveAs: async (filePath: string) => {
        const fsmod = await import("node:fs");
        fsmod.writeFileSync(filePath, "PDF-bytes");
      },
      suggestedFilename: () => "report.pdf",
      url: () => "https://example.com/report.pdf"
    });

    const downloads = await service.listDownloads({ sessionId: SESSION });
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.status).toBe("succeeded");
    expect(downloads[0]?.artifact?.name).toBe("report.pdf");

    await service.dispose();
  });

  test("closes a page and reports remaining pages", async () => {
    const service = await createService();
    const first = await service.openPage({ sessionId: SESSION, url: "https://example.com" });

    const closed = await service.closePage({ sessionId: SESSION });
    expect(closed.closedPageId).toBe(first.page.id);
    expect(closed.pages).toEqual([]);
    expect(closed.activePageId).toBeNull();

    await service.dispose();
  });

  test("rejects actions when no page is open, the page id is unknown, or no target is given", async () => {
    const service = await createService();
    await expect(service.navigate({ sessionId: SESSION, url: "https://example.com" })).rejects.toMatchObject({
      code: "browser_page_missing"
    });

    await service.openPage({ sessionId: SESSION, url: "https://example.com" });
    await expect(service.snapshot({ pageId: "browser.page.nope", sessionId: SESSION })).rejects.toMatchObject({
      code: "browser_page_not_found"
    });
    await expect(service.click({ sessionId: SESSION })).rejects.toMatchObject({ code: "browser_target_required" });

    await service.dispose();
  });

  test("surfaces a structured error when the browser fails to launch", async () => {
    const service = await createService();
    chromiumMock.__setLaunchError(new Error("chromium missing"));
    await expect(service.openPage({ sessionId: SESSION })).rejects.toMatchObject({ code: "browser_launch_failed" });
  });
});
