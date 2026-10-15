import { describe, expect, test } from "vitest";

import { browserCommandFor } from "@/commands/mcp";

describe("browserCommandFor", () => {
  const url = "https://auth.example.com/authorize?client_id=aia&state=a&scope=b";

  test("opens http(s) pages with each platform's own opener", () => {
    expect(browserCommandFor(url, "darwin")).toEqual(["open", [url]]);
    expect(browserCommandFor(url, "linux")).toEqual(["xdg-open", [url]]);
    // Not `cmd /c start`: cmd reparses the URL, so the `&` between query
    // parameters ends the command and whatever follows runs as another.
    expect(browserCommandFor(url, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", url]]);
  });

  test("refuses anything that is not an http(s) URL", () => {
    // A server picks the authorization URL; it must not get to start a
    // program or open a local file.
    for (const target of ["file:///etc/passwd", "javascript:alert(1)", "ms-settings:privacy", "smb://host/share"]) {
      expect(() => browserCommandFor(target, "darwin")).toThrow(/sign-in pages are http\(s\) only/u);
    }
    expect(() => browserCommandFor("not a url", "linux")).toThrow("it is not a valid URL");
  });
});
