import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { APPLE_NATIVE_VOICE_HELPER_SOURCE } from "@/core/voice/apple-helper-source";

// The unit tests stub swiftc, so nothing noticed that the shipped helper no
// longer compiled: `@main` needs -parse-as-library in a file not named
// main.swift, and `availableOutputFileTypes` became a class method. This
// compiles the real source with the real compiler, with the same flags the
// adapter uses. It only compiles: nothing runs that could reach the
// microphone or speech recognition.
const SWIFTC = "/usr/bin/swiftc";
const compileTest = process.platform === "darwin" && existsSync(SWIFTC) ? test : test.skip;
const run = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => fs.rm(root, { force: true, recursive: true })));
});

describe("Apple voice helper source", () => {
  compileTest(
    "compiles with the flags the adapter uses and runs",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-voice-helper-"));
      tempRoots.push(root);
      const sourcePath = path.join(root, "apple-native-voice-helper.swift");
      const binaryPath = path.join(root, "apple-native-voice-helper");
      await fs.writeFile(sourcePath, APPLE_NATIVE_VOICE_HELPER_SOURCE, "utf8");

      const compiled = await run(
        SWIFTC,
        ["-parse-as-library", sourcePath, "-framework", "AVFoundation", "-framework", "Speech", "-o", binaryPath],
        { timeout: 280_000 }
      );
      expect(compiled.stderr).not.toMatch(/error:/u);

      // An unknown command answers before any device or permission code runs.
      const result = await run(binaryPath, ["no-such-command"]).catch((error: { stdout?: string }) => error);
      expect(JSON.parse((result.stdout ?? "").trim())).toMatchObject({
        error: { code: "voice_helper_unknown_command" },
        ok: false
      });
    },
    300_000
  );
});
