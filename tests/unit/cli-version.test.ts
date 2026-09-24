import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { runCli } from "@/cli";

function captureStreams() {
  const output = { stderr: "", stdout: "" };
  return {
    output,
    streams: {
      stderr: {
        write: (value: string) => {
          output.stderr += value;
          return true;
        }
      },
      stdout: {
        write: (value: string) => {
          output.stdout += value;
          return true;
        }
      }
    }
  };
}

/** The version the CLI must report: the manifest's, so the two cannot drift. */
function manifestVersion(): string {
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
  return manifest.version;
}

describe("aia --version", () => {
  test("prints the package version on stdout and exits 0 without starting a session", async () => {
    const { output, streams } = captureStreams();

    await expect(runCli(["--version"], streams)).resolves.toBe(0);

    expect(output.stdout).toBe(`aia ${manifestVersion()}\n`);
    expect(output.stderr).toBe("");
  });

  test("is listed in --help", async () => {
    const { output, streams } = captureStreams();

    await expect(runCli(["--help"], streams)).resolves.toBe(0);

    expect(output.stdout).toContain("aia --version");
  });
});
