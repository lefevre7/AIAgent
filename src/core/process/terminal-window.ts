import { spawn } from "node:child_process";

export type TerminalWindowLauncher = (params: { command: string; terminalApp: string }) => Promise<void>;

/**
 * Opens a real terminal window on the macOS desktop running `command`.
 *
 * This exists so the human and the agent can drive the *same* interactive
 * session: the window runs `aia attach <id>`, which relays keystrokes over the
 * gateway into the very PTY the agent writes to.
 *
 * It runs when an interactive session starts (`externalAgents.interactive.
 * autoAttachOnStart`, and only while this process serves a listener the window
 * can reach) and on an explicit attach. Starting a session is approval-gated,
 * so a window only ever appears for a session the operator approved.
 */
export async function openTerminalWindow(params: { command: string; terminalApp: string }): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error(
      `Opening a terminal window is only supported on macOS. Run this yourself instead: ${params.command}`
    );
  }

  // AppleScript string literals escape only backslash and double quote.
  const script = `tell application ${quoteAppleScript(params.terminalApp)} to do script ${quoteAppleScript(params.command)}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }

      reject(new Error(`osascript exited with code ${exitCode ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}

/**
 * Quotes a value for an AppleScript string literal, which escapes only
 * backslash and double quote.
 *
 * This is the injection boundary: `do script` hands its argument to a shell,
 * so anything that escapes the literal becomes a command. Exported so it can
 * be tested directly — the function around it spawns a real window, which a
 * test cannot do.
 */
export function quoteAppleScript(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
