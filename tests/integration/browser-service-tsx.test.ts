import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

// Vitest compiles without esbuild's keepNames, so the other browser tests never
// saw what `npm run dev` (tsx) did: every named inner function in a page script
// became a `__name(...)` call, and the page, which has no such helper, threw
// "__name is not defined" on the first snapshot. This runs the real service
// under tsx, the way aia runs in development.
const loadModule = createRequire(import.meta.url);
const CHROMIUM_AVAILABLE = await (async () => {
  try {
    const { chromium } = loadModule("playwright") as {
      chromium: { launch: (o: unknown) => Promise<{ close: () => Promise<void> }> };
    };
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
})();

const realTest = CHROMIUM_AVAILABLE ? test : test.skip;
const run = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => fs.rm(root, { force: true, recursive: true })));
});

describe("browser service under tsx", () => {
  realTest(
    "snapshots a page and selects an option",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-browser-tsx-"));
      tempRoots.push(root);
      const script = path.join(root, "drive.mts");
      const servicePath = path.resolve("src/core/browser/service.ts");
      await fs.writeFile(
        script,
        [
          `import { createPlaywrightBrowserAutomationService } from ${JSON.stringify(servicePath)};`,
          `const service = createPlaywrightBrowserAutomationService({ actionTimeoutMs: 5000, artifactRoot: ${JSON.stringify(root)}, headless: true });`,
          'const sessionId = "session.browser.tsx";',
          "try {",
          `  await service.openPage({ sessionId, url: "data:text/html,<title>Fixture</title><button id='go'>Go</button><select id='pick'><option value='a'>Alpha</option><option value='b'>Beta</option></select>" });`,
          "  const snapshot = await service.snapshot({ sessionId });",
          '  await service.selectOptions({ selector: "#pick", sessionId, values: ["Beta"] });',
          "  console.log(JSON.stringify({ elements: snapshot.elements.map((element) => element.tagName), title: snapshot.title }));",
          "} finally {",
          "  await service.dispose();",
          "}"
        ].join("\n"),
        "utf8"
      );

      const { stdout } = await run(process.execPath, ["--import", "tsx", script], {
        cwd: process.cwd(),
        env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve("tsconfig.json") },
        timeout: 60_000
      });

      const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { elements: string[]; title: string };
      expect(result.title).toBe("Fixture");
      expect(result.elements).toEqual(expect.arrayContaining(["button", "select"]));
    },
    90_000
  );
});
