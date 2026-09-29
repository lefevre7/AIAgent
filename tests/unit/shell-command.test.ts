import { describe, expect, test } from "vitest";

import { analyzeShellCommand } from "@/core/approvals/shell-command";

describe("shell command analysis for approvals", () => {
  test("splits a line into the commands it runs", () => {
    expect(analyzeShellCommand("ls; rm -rf ~/work").segments).toEqual(["ls", "rm -rf ~/work"]);
    expect(analyzeShellCommand("git status && npm test || echo failed").segments).toEqual([
      "git status",
      "npm test",
      "echo failed"
    ]);
    expect(analyzeShellCommand("cat notes.txt | head -n 5 |& wc -l").segments).toEqual([
      "cat notes.txt",
      "head -n 5",
      "wc -l"
    ]);
    expect(analyzeShellCommand("sleep 1 & ls\npwd").segments).toEqual(["sleep 1", "ls", "pwd"]);
  });

  test("keeps quoted and escaped separators inside their command", () => {
    expect(analyzeShellCommand(`grep "a;b|c" file && echo 'x && y'`).segments).toEqual([
      `grep "a;b|c" file`,
      "echo 'x && y'"
    ]);
    expect(analyzeShellCommand(String.raw`echo one\;two`).segments).toEqual([String.raw`echo one\;two`]);
  });

  test("unwraps grouping and negation so the command inside is what gets matched", () => {
    expect(analyzeShellCommand("(rm -rf /)").segments).toEqual(["rm -rf /"]);
    expect(analyzeShellCommand("{ ls; } && ! grep x y").segments).toEqual(["ls", "grep x y"]);
  });

  test("marks substitution and file-writing redirects as opaque", () => {
    for (const command of [
      "ls $(rm -rf x)",
      "echo `id`",
      'echo "$(whoami)"',
      "diff <(ls a) <(ls b)",
      "ls > files.txt",
      "ls >> files.txt",
      "ls &> all.txt",
      "ls >&all.txt",
      "echo 'unclosed"
    ]) {
      expect(analyzeShellCommand(command).opaque, command).toBe(true);
    }
  });

  test("does not count a quoted $( or harmless redirects as opaque", () => {
    for (const command of [
      "echo '$(not run)'",
      "find . -name x 2>/dev/null",
      "ls > /dev/null",
      "npm test 2>&1 | tail -n 20",
      "ls >&2",
      "cat < input.txt",
      "echo ${HOME}"
    ]) {
      expect(analyzeShellCommand(command).opaque, command).toBe(false);
    }
  });
});
