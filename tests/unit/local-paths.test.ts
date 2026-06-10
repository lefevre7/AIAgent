import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveLocalPath } from "@/core/tools/builtins/local-paths";

describe("resolveLocalPath", () => {
  test("expands a leading ~ to the home directory", () => {
    expect(resolveLocalPath("~/temp/index.html", "/base")).toBe(path.join(os.homedir(), "temp", "index.html"));
    expect(resolveLocalPath("~", "/base")).toBe(path.resolve(os.homedir()));
  });

  test("resolves relative paths against the base directory and keeps absolute paths", () => {
    expect(resolveLocalPath("src/file.ts", "/base/dir")).toBe(path.resolve("/base/dir", "src/file.ts"));
    expect(resolveLocalPath("/abs/file.ts", "/base/dir")).toBe(path.resolve("/abs/file.ts"));
  });

  test("resolves file:// URIs", () => {
    const target = path.join(os.tmpdir(), "x.txt");
    expect(resolveLocalPath(`file://${target}`, "/base")).toBe(path.resolve(target));
  });
});
