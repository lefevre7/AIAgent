import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scripts = (
  JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }
).scripts;

/** Flattens `npm run a && npm run b` chains into the commands they finally run. */
function expandScript(name: string): string[] {
  const body = scripts[name];
  if (body === undefined) {
    throw new Error(`package.json has no "${name}" script.`);
  }
  return body
    .split("&&")
    .map((step) => step.trim())
    .flatMap((step) => {
      const nested = /^npm run (\S+)$/u.exec(step);
      return nested ? expandScript(nested[1]) : [step];
    });
}

/** Which test layers one command runs. The coverage config runs both vitest projects. */
function suitesRunBy(command: string): string[] {
  if (command.includes("vitest.coverage.config.ts")) {
    return ["integration", "unit"];
  }
  if (command.includes("vitest.unit.config.ts")) {
    return ["unit"];
  }
  if (command.includes("vitest.integration.config.ts")) {
    return ["integration"];
  }
  if (command.includes("vitest.live.config.ts")) {
    return ["live"];
  }
  return command.startsWith("playwright test") ? ["e2e"] : [];
}

describe("validate:penultimate", () => {
  // The gate once left coverage out entirely, so the floor drifted below
  // itself unnoticed. Adding it back then ran unit and integration twice: once
  // plainly, then again under coverage.
  test("runs every test layer exactly once, plus the static checks", () => {
    const commands = expandScript("validate:penultimate");

    expect(commands.flatMap(suitesRunBy).sort()).toEqual(["e2e", "integration", "live", "unit"]);
    expect(commands.some((command) => command.includes("vitest.coverage.config.ts"))).toBe(true);
    expect(commands).toEqual(expect.arrayContaining([scripts.typecheck, scripts.lint, scripts["format:check"]]));
  });
});
