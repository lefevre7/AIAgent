import { execFileSync } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

import type { ExternalAgentSessionService } from "@/core/contracts";
import { buildAttachCommand, createExternalAgentSessionHost } from "@/gateway/runtime";

// The real launcher runs osascript and opens a Terminal window.
const { opened } = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("@/core/process/terminal-window", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/process/terminal-window")>()),
  openTerminalWindow: async ({ command }: { command: string }) => {
    opened.push(command);
  }
}));

function createHost(options: { autoAttachOnStart?: boolean } = {}) {
  opened.length = 0;
  const attachEndpoint: { url?: string } = {};
  const noted: string[] = [];
  const host = createExternalAgentSessionHost({
    attachEndpoint,
    autoAttachOnStart: options.autoAttachOnStart ?? true,
    cwd: "/Users/someone/code/project",
    service: {
      noteAttached: async (externalSessionId: string) => {
        noted.push(externalSessionId);
      }
    } as unknown as ExternalAgentSessionService,
    terminalApp: "Terminal"
  });
  return { attachEndpoint, host, noted };
}

// The window's shell is started by the terminal app, never inheriting this
// process's cwd, so a bare `aia attach <id>` read another state root, found no
// endpoint, and dialled a port nothing listened on — while the model was told
// the terminal was shared. `--prompt` and SDK hosts, which serve no listener,
// opened such a window every time.
describe("external-agent session host", () => {
  test("opens no window while this process serves no listener", async () => {
    const { host, noted } = createHost();

    expect(host.autoAttachOnStart).toBe(false);
    await expect(host.attach("external-agent-session.abc")).rejects.toThrow(/not serving a gateway endpoint/u);
    expect(opened).toEqual([]);
    expect(noted).toEqual([]);
  });

  test("once a listener is served, the window names it and the workspace", async () => {
    const { attachEndpoint, host, noted } = createHost();
    attachEndpoint.url = "ws://127.0.0.1:52011/api/gateway/ws";

    expect(host.autoAttachOnStart).toBe(true);
    const result = await host.attach("external-agent-session.abc");

    expect(result.command).toBe(
      "aia attach external-agent-session.abc --url ws://127.0.0.1:52011/api/gateway/ws --cwd /Users/someone/code/project"
    );
    expect(opened).toEqual([result.command]);
    expect(noted).toEqual(["external-agent-session.abc"]);
  });

  test("autoAttachOnStart off keeps sessions headless even with a listener", () => {
    const { attachEndpoint, host } = createHost({ autoAttachOnStart: false });
    attachEndpoint.url = "ws://127.0.0.1:52011/api/gateway/ws";

    expect(host.autoAttachOnStart).toBe(false);
  });
});

describe("buildAttachCommand", () => {
  // `do script` hands the command to a shell: a workspace path is operator
  // data, and anything that escaped its quoting would run as a command.
  test.skipIf(process.platform === "win32")("quotes every argument so the shell sees each one intact", () => {
    const cwd = `/tmp/it's a "dir" with $HOME and \`date\` and \\slashes`;
    const url = "ws://127.0.0.1:52011/api/gateway/ws";
    const command = buildAttachCommand("external-agent-session.abc", { cwd, url });

    const argv = execFileSync("/bin/sh", ["-c", command.replace(/^aia /u, `printf '%s\\n' `)], {
      encoding: "utf8"
    })
      .split("\n")
      .slice(0, -1);

    expect(argv).toEqual(["attach", "external-agent-session.abc", "--url", url, "--cwd", cwd]);
  });
});
