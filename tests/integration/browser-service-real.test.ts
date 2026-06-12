import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, test } from "vitest";

import { createPlaywrightBrowserAutomationService } from "@/core/browser/service";

// Detect whether a real Chromium bundle is installed. The DOM snapshot logic
// runs inside page.evaluate(), which a mock cannot execute — so this exercises
// it against a real (headless) browser when available, and skips otherwise.
const loadModule = createRequire(import.meta.url);
const CHROMIUM_AVAILABLE = await (async () => {
  try {
    const { chromium } = loadModule("playwright") as { chromium: { launch: (o: unknown) => Promise<{ close: () => Promise<void> }> } };
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
})();

const realTest = CHROMIUM_AVAILABLE ? test : test.skip;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 })));
});

const PAGE = "data:text/html,<html><head><title>Fixture</title></head><body><h1>Hello</h1><button id='go'>Go</button><input id='field' /><a href='#next'>Next</a></body></html>";

describe("PlaywrightBrowserAutomationService against real Chromium", () => {
  realTest("snapshots the live DOM and performs real page actions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-browser-real-"));
    tempRoots.push(root);
    const service = createPlaywrightBrowserAutomationService({ actionTimeoutMs: 5_000, artifactRoot: root, headless: true });
    const sessionId = "session.browser.real";

    try {
      const opened = await service.openPage({ sessionId, url: PAGE });
      expect(opened.createdPage).toBe(true);

      // snapshot() runs the in-browser element-extraction script.
      const snapshot = await service.snapshot({ sessionId });
      expect(snapshot.elements.length).toBeGreaterThan(0);
      expect(snapshot.elements.some((element) => element.tagName === "button")).toBe(true);
      expect(snapshot.title).toBe("Fixture");

      // a ref produced by the snapshot can drive subsequent actions
      const buttonRef = snapshot.elements.find((element) => element.tagName === "button")?.ref;
      expect(buttonRef).toBeTruthy();
      await service.click({ ref: buttonRef, sessionId });

      await service.fill({ selector: "#field", sessionId, text: "typed text" });

      const shot = await service.screenshot({ sessionId });
      expect(shot.mediaType).toBe("image/png");

      const pages = await service.listPages(sessionId);
      expect(pages.pages.length).toBeGreaterThanOrEqual(1);
    } finally {
      await service.dispose();
    }
  });
});

const RICH_PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<html><head><title>Rich</title></head><body>
      <label for="email">Email address</label>
      <input id="email" type="email" placeholder="you@example.com" />
      <input type="checkbox" checked aria-label="Accept terms" />
      <button disabled data-testid="save-btn">Save</button>
      <select name="country"><option value="us">US</option><option value="ca">CA</option></select>
      <textarea placeholder="Notes here"></textarea>
      <a href="/next" role="link">Continue</a>
      <div style="display:none"><button>Hidden Button</button></div>
      <span tabindex="0">Focusable</span>
    </body></html>`
  );

describe("PlaywrightBrowserAutomationService snapshot extraction (real Chromium)", () => {
  realTest("captures element attributes, labels, and visibility from a rich DOM", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-browser-rich-"));
    tempRoots.push(root);
    const service = createPlaywrightBrowserAutomationService({ actionTimeoutMs: 5_000, artifactRoot: root, headless: true });
    const sessionId = "session.browser.rich";

    try {
      await service.openPage({ sessionId, url: RICH_PAGE });
      const snapshot = await service.snapshot({ sessionId, maxElements: 50 });

      const byTag = (tag: string) => snapshot.elements.filter((element) => element.tagName === tag);
      expect(byTag("input").length).toBeGreaterThanOrEqual(2);
      // hidden button is excluded by the visibility filter
      expect(snapshot.elements.some((element) => element.text === "Hidden Button")).toBe(false);
      // a checkbox reports its checked state and an aria-label
      expect(snapshot.elements.some((element) => element.checked === true)).toBe(true);
      // the disabled button reports disabled + a data-testid locator hint
      const save = snapshot.elements.find((element) => element.text === "Save");
      expect(save?.disabled).toBe(true);
      // the labelled email input picks up its <label for> text and placeholder
      const email = snapshot.elements.find((element) => element.locatorHint === "#email");
      expect(email?.placeholder).toContain("example.com");
      expect(snapshot.textExcerpt ?? "").toContain("Email address");
    } finally {
      await service.dispose();
    }
  });
});
