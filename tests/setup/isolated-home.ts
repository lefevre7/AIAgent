import fs from "node:fs";
import path from "node:path";

import { afterAll, inject } from "vitest";

// A test that names no home directory of its own (`userHomeDirectory`) falls
// back to os.homedir(), which reads the developer's own ~/.aia: their config,
// MCP servers and credentials, trust grants and skills. Dozens of tests did.
// Each test file gets an empty home instead, so nothing a test does depends
// on, or changes, the machine it runs on. Child processes inherit it.
const home = fs.realpathSync(fs.mkdtempSync(path.join(inject("testHomesRoot"), "home-")));
process.env.HOME = home;
process.env.USERPROFILE = home;

afterAll(() => {
  fs.rmSync(home, { force: true, recursive: true });
});
