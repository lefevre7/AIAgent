import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type BrowserContext, type Download, type Locator, type Page } from "playwright";

import type {
  ArtifactReference,
  BrowserAutomationService,
  BrowserClosePageResult,
  BrowserDownloadRecord,
  BrowserListDownloadsParams,
  BrowserListPagesResult,
  BrowserLocator,
  BrowserOpenPageParams,
  BrowserOpenPageResult,
  BrowserPageActionParams,
  BrowserPageKeyActionParams,
  BrowserPageRecord,
  BrowserPageSelectionActionParams,
  BrowserPageSnapshot,
  BrowserPageTextActionParams,
  BrowserPageUploadParams,
  BrowserPageWaitParams,
  BrowserPointerActionParams,
  BrowserScreenshotParams,
  BrowserSnapshotParams,
  JsonValue,
  StructuredError
} from "@/core/contracts";

type RuntimeBrowserSession = {
  activePageId: string | null;
  context: BrowserContext;
  createdAt: string;
  pages: Map<string, RuntimeBrowserPage>;
  root: string;
  sessionId: string;
};

type RuntimeBrowserPage = {
  createdAt: string;
  downloads: Map<string, RuntimeBrowserDownload>;
  id: string;
  lastSnapshot: BrowserPageSnapshot | null;
  page: Page;
};

type RuntimeBrowserDownload = {
  artifact?: ArtifactReference;
  createdAt: string;
  errorMessage?: string;
  id: string;
  pageId: string;
  ready: Promise<void>;
  sessionId: string;
  status: BrowserDownloadRecord["status"];
  suggestedFilename?: string;
  url?: string;
};

export type PlaywrightBrowserAutomationServiceOptions = {
  actionTimeoutMs?: number;
  artifactRoot: string;
  headless?: boolean;
  launchTimeoutMs?: number;
  navigationTimeoutMs?: number;
  snapshotMaxElements?: number;
  snapshotTextChars?: number;
  viewport?: {
    height: number;
    width: number;
  };
};

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 120;
const DEFAULT_SNAPSHOT_TEXT_CHARS = 12_000;

export class PlaywrightBrowserAutomationService implements BrowserAutomationService {
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, RuntimeBrowserSession>();
  private readonly pageIds = new WeakMap<Page, string>();

  constructor(private readonly options: PlaywrightBrowserAutomationServiceOptions) {}

  async openPage(params: BrowserOpenPageParams): Promise<BrowserOpenPageResult> {
    const session = await this.ensureSession(params.sessionId);
    let runtimePage: RuntimeBrowserPage;
    let createdPage = false;

    if (params.newPage || !session.activePageId) {
      const page = await session.context.newPage();
      runtimePage = this.registerPage(session, page, {
        activate: true
      });
      createdPage = true;
    } else if (params.pageId) {
      runtimePage = await this.resolvePage(params);
      session.activePageId = runtimePage.id;
    } else {
      runtimePage = await this.resolvePage(params);
      session.activePageId = runtimePage.id;
    }

    let navigated = false;
    if (params.url) {
      await this.navigatePage(runtimePage.page, params.url);
      navigated = true;
    }

    return {
      createdPage,
      navigated,
      page: await this.serializePage(session, runtimePage)
    };
  }

  async listPages(sessionId: string): Promise<BrowserListPagesResult> {
    const session = await this.ensureSession(sessionId);
    const pages = await Promise.all(
      Array.from(session.pages.values())
        .filter((runtimePage) => !runtimePage.page.isClosed())
        .map((runtimePage) => this.serializePage(session, runtimePage))
    );

    return {
      activePageId: session.activePageId,
      pages
    };
  }

  async navigate(params: BrowserPageActionParams & { url: string }): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    await this.navigatePage(runtimePage.page, params.url);
    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async snapshot(params: BrowserSnapshotParams): Promise<BrowserPageSnapshot> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const page = runtimePage.page;
    const bodyLocator = page.locator("body");
    const ariaSnapshot = await bodyLocator.ariaSnapshot({
      timeout: this.actionTimeoutMs()
    });
    const extracted = await page.evaluate(
      ({ maxElements, maxTextChars }) => {
        const clearExistingRefs = () => {
          for (const element of Array.from(document.querySelectorAll("[data-aia-ref]"))) {
            element.removeAttribute("data-aia-ref");
          }
        };

        const normalizeText = (value: string | null | undefined) =>
          value
            ? value
                .replace(/\s+/gu, " ")
                .trim()
            : undefined;

        const buildLocatorHint = (element: HTMLElement) => {
          if (element.id) {
            return `#${element.id}`;
          }
          const testId =
            element.getAttribute("data-testid") ??
            element.getAttribute("data-test-id") ??
            element.getAttribute("data-qa") ??
            element.getAttribute("name");
          if (testId) {
            return `[${element.hasAttribute("name") ? "name" : "data-testid"}="${testId}"]`;
          }
          return element.tagName.toLowerCase();
        };

        const isVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        clearExistingRefs();

        const selectors = [
          "a[href]",
          "button",
          "input",
          "select",
          "textarea",
          "[role]",
          "[contenteditable='true']",
          "[tabindex]"
        ];

        const elements = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(",")))
          .filter((element) => isVisible(element))
          .slice(0, maxElements)
          .map((element, index) => {
            const ref = `e${index + 1}`;
            element.setAttribute("data-aia-ref", ref);
            const text = normalizeText(element.innerText || element.textContent)?.slice(0, 2000);
            const label =
              normalizeText(
                element.getAttribute("aria-label") ||
                  (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : undefined)
              )?.slice(0, 512) ?? undefined;

            return {
              checked:
                "checked" in element && typeof (element as HTMLInputElement).checked === "boolean"
                  ? (element as HTMLInputElement).checked
                  : undefined,
              disabled: "disabled" in element ? Boolean((element as HTMLInputElement).disabled) : undefined,
              inputType: element instanceof HTMLInputElement ? element.type || undefined : undefined,
              label,
              locatorHint: buildLocatorHint(element),
              placeholder: normalizeText(
                element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.placeholder : undefined
              )?.slice(0, 512),
              ref,
              role: normalizeText(element.getAttribute("role")) ?? undefined,
              tagName: element.tagName.toLowerCase(),
              text
            };
          });

        const fullText = normalizeText(document.body?.innerText);
        const bodyText = fullText?.slice(0, maxTextChars);

        return {
          elements,
          textExcerpt: bodyText,
          title: document.title || undefined,
          truncated: Boolean(fullText && bodyText && fullText.length > bodyText.length),
          url: window.location.href
        };
      },
      {
        maxElements: params.maxElements ?? this.snapshotMaxElements(),
        maxTextChars: params.maxTextChars ?? this.snapshotTextChars()
      }
    );

    const snapshot: BrowserPageSnapshot = {
      ariaSnapshot: ariaSnapshot.trim() || undefined,
      elements: extracted.elements,
      metadata: {},
      pageId: runtimePage.id,
      sessionId: session.sessionId,
      takenAt: new Date().toISOString(),
      textExcerpt: extracted.textExcerpt,
      title: extracted.title,
      truncated: extracted.truncated,
      url: extracted.url
    };

    runtimePage.lastSnapshot = snapshot;
    session.activePageId = runtimePage.id;
    return snapshot;
  }

  async screenshot(params: BrowserScreenshotParams): Promise<ArtifactReference> {
    const runtimePage = await this.resolvePage(params);
    const imageType = params.imageType ?? "png";
    const screenshotsRoot = await this.ensureBrowserArtifactDirectory(params.sessionId, "screenshots");
    const fileName = `${runtimePage.id}.${crypto.randomUUID()}.${imageType}`;
    const filePath = path.join(screenshotsRoot, fileName);
    const locator = this.resolveLocator(runtimePage, params);

    if (locator) {
      await locator.screenshot({
        path: filePath,
        type: imageType
      });
    } else {
      await runtimePage.page.screenshot({
        fullPage: params.fullPage ?? false,
        path: filePath,
        type: imageType
      });
    }

    return createArtifactReference(filePath, "image", {
      mediaType: imageType === "jpeg" ? "image/jpeg" : "image/png",
      metadata: {
        pageId: runtimePage.id,
        source: "browser_screenshot"
      },
      name: path.basename(filePath)
    });
  }

  async click(params: BrowserPointerActionParams): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const locator = this.resolveRequiredLocator(runtimePage, params);

    if (params.doubleClick) {
      await locator.dblclick({
        button: params.button,
        modifiers: params.modifiers,
        timeout: this.actionTimeoutMs()
      });
    } else {
      await locator.click({
        button: params.button,
        modifiers: params.modifiers,
        timeout: this.actionTimeoutMs()
      });
    }

    await this.waitForPostActionSettling(runtimePage.page);
    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async fill(params: BrowserPageTextActionParams): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const locator = this.resolveRequiredLocator(runtimePage, params);

    await locator.fill(params.text, {
      timeout: this.actionTimeoutMs()
    });

    if (params.submit) {
      await locator.press("Enter", {
        timeout: this.actionTimeoutMs()
      });
    }

    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async type(params: BrowserPageTextActionParams & { delayMs?: number }): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const locator = this.resolveRequiredLocator(runtimePage, params);

    await locator.pressSequentially(params.text, {
      delay: params.delayMs ?? 0,
      timeout: this.actionTimeoutMs()
    });

    if (params.submit) {
      await locator.press("Enter", {
        timeout: this.actionTimeoutMs()
      });
    }

    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async selectOptions(params: BrowserPageSelectionActionParams): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const locator = this.resolveRequiredLocator(runtimePage, params);
    const optionValues = await locator.evaluate(
      (element, requestedValues) => {
        if (!(element instanceof HTMLSelectElement)) {
          throw new Error("Target element is not a <select> element.");
        }

        const resolved = requestedValues.map((requested) => {
          const normalized = requested.trim().toLowerCase();
          const directMatch = Array.from(element.options).find(
            (option) => option.value.trim().toLowerCase() === normalized || option.label.trim().toLowerCase() === normalized
          );
          return directMatch?.value ?? requested;
        });

        return Array.from(new Set(resolved));
      },
      params.values
    );

    await locator.selectOption(optionValues, {
      timeout: this.actionTimeoutMs()
    });

    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async press(params: BrowserPageKeyActionParams): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const locator = this.resolveLocator(runtimePage, params);

    if (locator) {
      await locator.press(params.key, {
        timeout: this.actionTimeoutMs()
      });
    } else {
      await runtimePage.page.keyboard.press(params.key);
    }

    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async upload(params: BrowserPageUploadParams): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const locator = this.resolveRequiredLocator(runtimePage, params);

    await locator.setInputFiles(params.paths, {
      timeout: this.actionTimeoutMs()
    });

    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async waitFor(params: BrowserPageWaitParams): Promise<BrowserPageRecord> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);

    if (typeof params.timeMs === "number") {
      await sleep(params.timeMs);
    } else if (params.url) {
      await runtimePage.page.waitForURL(params.url, {
        timeout: params.timeoutMs ?? this.navigationTimeoutMs()
      });
    } else if (params.text) {
      await runtimePage.page.getByText(params.text, { exact: false }).first().waitFor({
        timeout: params.timeoutMs ?? this.actionTimeoutMs()
      });
    } else if (params.textGone) {
      await waitForTextGone(runtimePage.page, params.textGone, params.timeoutMs ?? this.actionTimeoutMs());
    } else {
      const locator = this.resolveRequiredLocator(runtimePage, params);
      await locator.waitFor({
        state: "visible",
        timeout: params.timeoutMs ?? this.actionTimeoutMs()
      });
    }

    session.activePageId = runtimePage.id;
    return this.serializePage(session, runtimePage);
  }

  async listDownloads(params: BrowserListDownloadsParams & { sessionId: string }): Promise<BrowserDownloadRecord[]> {
    const session = await this.ensureSession(params.sessionId);
    const pages = params.pageId ? [await this.resolvePage(params)] : Array.from(session.pages.values());

    await Promise.all(
      pages.flatMap((runtimePage) =>
        Array.from(runtimePage.downloads.values()).map((download) => settleDownload(download, 250))
      )
    );

    return pages
      .flatMap((runtimePage) => Array.from(runtimePage.downloads.values()))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, params.limit ?? 50)
      .map((download) => ({
        artifact: download.artifact,
        createdAt: download.createdAt,
        errorMessage: download.errorMessage,
        id: download.id,
        metadata: {},
        pageId: download.pageId,
        sessionId: download.sessionId,
        status: download.status,
        suggestedFilename: download.suggestedFilename,
        url: download.url
      }));
  }

  async closePage(params: BrowserPageActionParams): Promise<BrowserClosePageResult> {
    const session = await this.ensureSession(params.sessionId);
    const runtimePage = await this.resolvePage(params);
    const closedPageId = runtimePage.id;

    await runtimePage.page.close({
      runBeforeUnload: false
    });

    session.pages.delete(closedPageId);
    if (session.activePageId === closedPageId) {
      session.activePageId = Array.from(session.pages.keys())[0] ?? null;
    }

    const pages = await Promise.all(Array.from(session.pages.values()).map((page) => this.serializePage(session, page)));

    return {
      activePageId: session.activePageId,
      closedPageId,
      pages
    };
  }

  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map(async (session) => {
        try {
          await session.context.close();
        } catch {
          // Ignore close races during test shutdown.
        }
      })
    );
    this.sessions.clear();

    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      this.browserPromise = null;
      await browser.close();
      return;
    }

    if (this.browserPromise) {
      const browser = await this.browserPromise;
      this.browserPromise = null;
      this.browser = null;
      await browser.close();
    }
  }

  private async ensureSession(sessionId: string): Promise<RuntimeBrowserSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const browser = await this.ensureBrowser();
    const root = path.join(this.options.artifactRoot, sanitizeSegment(sessionId));
    await fs.mkdir(root, {
      recursive: true
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: this.options.viewport
    });
    context.setDefaultTimeout(this.actionTimeoutMs());
    context.setDefaultNavigationTimeout(this.navigationTimeoutMs());

    const session: RuntimeBrowserSession = {
      activePageId: null,
      context,
      createdAt: new Date().toISOString(),
      pages: new Map(),
      root,
      sessionId
    };

    context.on("page", (page) => {
      this.registerPage(session, page, {
        activate: true
      });
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }

    if (!this.browserPromise) {
      this.browserPromise = chromium
        .launch({
          headless: this.options.headless ?? true,
          timeout: this.options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
        })
        .catch((error) => {
          this.browserPromise = null;
          throw browserError(
            "browser_launch_failed",
            error instanceof Error
              ? `${error.message}. Install the Chromium browser bundle with "npx playwright install chromium" if it is missing.`
              : "Failed to launch the Playwright Chromium browser.",
            {
              headless: this.options.headless ?? true
            },
            true
          );
        });
    }

    this.browser = await this.browserPromise;
    return this.browser;
  }

  private registerPage(
    session: RuntimeBrowserSession,
    page: Page,
    options: {
      activate: boolean;
    }
  ): RuntimeBrowserPage {
    const existingId = this.pageIds.get(page);
    if (existingId) {
      const existing = session.pages.get(existingId);
      if (existing) {
        if (options.activate) {
          session.activePageId = existing.id;
        }
        return existing;
      }
    }

    const runtimePage: RuntimeBrowserPage = {
      createdAt: new Date().toISOString(),
      downloads: new Map(),
      id: `browser.page.${crypto.randomUUID()}`,
      lastSnapshot: null,
      page
    };

    this.pageIds.set(page, runtimePage.id);
    session.pages.set(runtimePage.id, runtimePage);
    if (options.activate) {
      session.activePageId = runtimePage.id;
    }

    page.on("download", (download) => {
      void this.captureDownload(session, runtimePage, download);
    });
    page.on("close", () => {
      session.pages.delete(runtimePage.id);
      if (session.activePageId === runtimePage.id) {
        session.activePageId = Array.from(session.pages.keys())[0] ?? null;
      }
    });

    return runtimePage;
  }

  private async resolvePage(params: BrowserPageActionParams): Promise<RuntimeBrowserPage> {
    const session = await this.ensureSession(params.sessionId);
    const pageId = params.pageId ?? session.activePageId;
    if (!pageId) {
      throw browserError("browser_page_missing", "No browser page is open for this session yet. Use browser_open first.", {
        sessionId: params.sessionId
      });
    }

    const runtimePage = session.pages.get(pageId);
    if (!runtimePage || runtimePage.page.isClosed()) {
      throw browserError("browser_page_not_found", `No open browser page with id "${pageId}" exists for this session.`, {
        pageId,
        sessionId: params.sessionId
      });
    }

    return runtimePage;
  }

  private resolveLocator(runtimePage: RuntimeBrowserPage, locator: BrowserLocator, required = false): Locator | null {
    if (locator.ref) {
      return runtimePage.page.locator(`[data-aia-ref="${escapeAttributeValue(locator.ref)}"]`).first();
    }
    if (locator.selector) {
      return runtimePage.page.locator(locator.selector).first();
    }
    if (required) {
      throw browserError(
        "browser_target_required",
        "This browser action requires either a snapshot ref or a selector.",
        {
          pageId: runtimePage.id
        }
      );
    }
    return null;
  }

  private resolveRequiredLocator(runtimePage: RuntimeBrowserPage, locator: BrowserLocator): Locator {
    return this.resolveLocator(runtimePage, locator, true) as Locator;
  }

  private async serializePage(session: RuntimeBrowserSession, runtimePage: RuntimeBrowserPage): Promise<BrowserPageRecord> {
    let title: string | undefined;
    try {
      title = (await runtimePage.page.title()) || undefined;
    } catch {
      title = undefined;
    }

    return {
      active: session.activePageId === runtimePage.id,
      createdAt: runtimePage.createdAt,
      id: runtimePage.id,
      metadata: {},
      sessionId: session.sessionId,
      title,
      url: runtimePage.page.url() || "about:blank"
    };
  }

  private async ensureBrowserArtifactDirectory(sessionId: string, name: string): Promise<string> {
    const session = await this.ensureSession(sessionId);
    const directory = path.join(session.root, name);
    await fs.mkdir(directory, {
      recursive: true
    });
    return directory;
  }

  private async captureDownload(session: RuntimeBrowserSession, runtimePage: RuntimeBrowserPage, download: Download): Promise<void> {
    const id = `browser.download.${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const record: RuntimeBrowserDownload = {
      createdAt,
      id,
      pageId: runtimePage.id,
      ready: Promise.resolve(),
      sessionId: session.sessionId,
      status: "pending",
      suggestedFilename: download.suggestedFilename() || undefined,
      url: download.url() || undefined
    };

    runtimePage.downloads.set(id, record);
    record.ready = this.persistDownload(session, runtimePage, download, record);
    await record.ready;
  }

  private async persistDownload(
    session: RuntimeBrowserSession,
    runtimePage: RuntimeBrowserPage,
    download: Download,
    record: RuntimeBrowserDownload
  ): Promise<void> {
    try {
      const downloadsRoot = await this.ensureBrowserArtifactDirectory(session.sessionId, path.join("downloads", runtimePage.id));
      const fileName = sanitizeSegment(record.suggestedFilename ?? `download-${record.id}`);
      const filePath = path.join(downloadsRoot, fileName);
      await download.saveAs(filePath);
      record.artifact = await createArtifactReference(filePath, inferArtifactKindFromPath(filePath), {
        metadata: {
          pageId: runtimePage.id,
          source: "browser_download"
        },
        name: record.suggestedFilename ?? path.basename(filePath)
      });
      record.status = "succeeded";
    } catch (error) {
      record.status = "failed";
      record.errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  private actionTimeoutMs(): number {
    return this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  private navigationTimeoutMs(): number {
    return this.options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  }

  private snapshotMaxElements(): number {
    return this.options.snapshotMaxElements ?? DEFAULT_SNAPSHOT_MAX_ELEMENTS;
  }

  private snapshotTextChars(): number {
    return this.options.snapshotTextChars ?? DEFAULT_SNAPSHOT_TEXT_CHARS;
  }

  private async navigatePage(page: Page, url: string): Promise<void> {
    await page.goto(validateBrowserUrl(url), {
      timeout: this.navigationTimeoutMs(),
      waitUntil: "domcontentloaded"
    });
  }

  private async waitForPostActionSettling(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("domcontentloaded", {
        timeout: 500
      });
    } catch {
      // Most actions do not trigger navigation; this only helps when they do.
    }
  }
}

export function createPlaywrightBrowserAutomationService(options: PlaywrightBrowserAutomationServiceOptions) {
  return new PlaywrightBrowserAutomationService(options);
}

async function createArtifactReference(
  filePath: string,
  kind: ArtifactReference["kind"],
  options: {
    mediaType?: string;
    metadata?: Record<string, JsonValue>;
    name?: string;
  } = {}
): Promise<ArtifactReference> {
  const content = await fs.readFile(filePath);
  return {
    byteLength: content.byteLength,
    id: `artifact.${crypto.randomUUID()}`,
    kind,
    mediaType: options.mediaType,
    metadata: options.metadata ?? {},
    name: options.name ?? path.basename(filePath),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    uri: pathToFileURL(filePath).toString()
  };
}

function browserError(
  code: string,
  message: string,
  details: Record<string, JsonValue> = {},
  retriable = false
): StructuredError {
  return {
    code,
    details,
    message,
    retriable
  };
}

function escapeAttributeValue(value: string): string {
  return value.replace(/"/gu, '\\"');
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function inferArtifactKindFromPath(filePath: string): ArtifactReference["kind"] {
  const extension = path.extname(filePath).toLowerCase();
  if ([".jpeg", ".jpg", ".png", ".webp"].includes(extension)) {
    return "image";
  }
  if ([".json"].includes(extension)) {
    return "json";
  }
  if ([".log", ".txt", ".md"].includes(extension)) {
    return "text";
  }
  return "document";
}

async function settleDownload(download: RuntimeBrowserDownload, timeoutMs: number): Promise<void> {
  await Promise.race([download.ready, sleep(timeoutMs)]);
}

async function waitForTextGone(page: Page, text: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const present = await page.evaluate((needle) => document.body?.innerText?.includes(needle) ?? false, text);
    if (!present) {
      return;
    }
    await sleep(150);
  }

  throw browserError("browser_wait_timeout", `Timed out waiting for text "${text}" to disappear.`, {
    timeoutMs
  });
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function validateBrowserUrl(url: string): string {
  if (url === "about:blank") {
    return url;
  }

  if (url.startsWith("data:")) {
    return url;
  }

  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw browserError("browser_invalid_url", `Unsupported browser URL protocol "${parsed.protocol}".`, {
      url
    });
  }

  return parsed.toString();
}
