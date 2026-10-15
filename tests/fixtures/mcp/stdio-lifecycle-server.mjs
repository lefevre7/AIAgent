// A stdio MCP server for the manager's lifecycle tests. Behaviour is chosen by
// environment variables so one fixture covers every case:
//
// - MCP_TEST_INSTRUCTIONS: the server's `instructions`.
// - MCP_TEST_START_DELAY_MS: wait this long before answering the handshake.
// - MCP_TEST_TOOL_COUNT: register this many extra tools (bulk_0, bulk_1, ...).
// - MCP_TEST_CRASH_BEFORE_HANDSHAKE: write to stderr and exit 5 at once.
// - MCP_TEST_CRASH_AFTER_CONNECT_MS: exit 4 this long after the handshake.
// - MCP_TEST_LISTS: also serve a prompt and a resource, and the add_everything
//   tool.
// - MCP_TEST_LINGER_MS: stay up this long after stdin closes (a slow exit).
//
// Tools: echo, env (reads one variable), slow (waits, optionally reporting
// progress), ask (elicits a form and returns the answer), add_tool (registers
// a tool, which sends tools/list_changed), add_everything (registers a tool, a
// prompt and a resource at once: three list_changed notices), crash (writes to
// stderr and exits).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

const server = new McpServer(
  { name: "test-lifecycle-server", version: "1.0.0" },
  process.env.MCP_TEST_INSTRUCTIONS ? { instructions: process.env.MCP_TEST_INSTRUCTIONS } : {}
);

server.registerTool(
  "echo",
  { description: "Echo the provided text back.", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ text: `echo:${text}`, type: "text" }] })
);

server.registerTool(
  "env",
  { description: "Report one environment variable.", inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ text: process.env[name] ?? "<unset>", type: "text" }] })
);

server.registerTool(
  "slow",
  {
    description: "Wait, optionally reporting progress.",
    inputSchema: { ms: z.number(), progress: z.boolean().optional() }
  },
  async ({ ms, progress }, extra) => {
    const token = extra._meta?.progressToken;
    const started = Date.now();
    let step = 0;
    while (Date.now() - started < ms) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (progress && token !== undefined) {
        step += 1;
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progress: step, progressToken: token }
        });
      }
    }
    return { content: [{ text: `slept:${ms}`, type: "text" }] };
  }
);

server.registerTool("ask", { description: "Ask the operator for details." }, async () => {
  const answer = await server.server.elicitInput({
    message: "Who is deploying?",
    requestedSchema: {
      properties: {
        count: { description: "How many replicas", type: "integer" },
        name: { title: "Your name", type: "string" },
        ok: { type: "boolean" }
      },
      required: ["name", "count"],
      type: "object"
    }
  });
  return { content: [{ text: JSON.stringify(answer), type: "text" }] };
});

server.registerTool("add_tool", { description: "Register one more tool." }, async () => {
  server.registerTool("late", { description: "A tool added after startup." }, async () => ({
    content: [{ text: "late", type: "text" }]
  }));
  return { content: [{ text: "added", type: "text" }] };
});

if (process.env.MCP_TEST_LISTS) {
  // Registered before connecting: a server cannot add the prompts or
  // resources capability once it is connected.
  server.registerPrompt("first_prompt", { description: "A prompt served from the start." }, async () => ({
    messages: [{ content: { text: "first", type: "text" }, role: "user" }]
  }));
  server.registerResource("first", "test://first", { description: "A resource served from the start." }, async () => ({
    contents: [{ text: "first", uri: "test://first" }]
  }));
  server.registerTool("add_everything", { description: "Register a tool, a prompt and a resource." }, async () => {
    server.registerTool("late_tool", { description: "A tool added after startup." }, async () => ({
      content: [{ text: "late", type: "text" }]
    }));
    server.registerPrompt("late_prompt", { description: "A prompt added after startup." }, async () => ({
      messages: [{ content: { text: "late", type: "text" }, role: "user" }]
    }));
    server.registerResource("late", "test://late", { description: "A resource added after startup." }, async () => ({
      contents: [{ text: "late", uri: "test://late" }]
    }));
    return { content: [{ text: "added", type: "text" }] };
  });
}

server.registerTool("crash", { description: "Exit abruptly." }, async () => {
  process.stderr.write("boom: the fixture crashed on purpose\n");
  setTimeout(() => process.exit(3), 20);
  return { content: [{ text: "crashing", type: "text" }] };
});

for (let index = 0; index < Number(process.env.MCP_TEST_TOOL_COUNT ?? 0); index += 1) {
  server.registerTool(`bulk_${index}`, { description: `Bulk tool ${index}.` }, async () => ({
    content: [{ text: `bulk:${index}`, type: "text" }]
  }));
}

if (process.env.MCP_TEST_CRASH_BEFORE_HANDSHAKE) {
  process.stderr.write("fatal: the fixture could not start on purpose\n");
  process.exit(5);
}

const linger = Number(process.env.MCP_TEST_LINGER_MS ?? 0);
if (linger > 0) {
  process.stdin.once("end", () => setTimeout(() => process.exit(0), linger));
}

const delay = Number(process.env.MCP_TEST_START_DELAY_MS ?? 0);
setTimeout(() => {
  server
    .connect(new StdioServerTransport())
    .then(() => {
      const crashAfter = Number(process.env.MCP_TEST_CRASH_AFTER_CONNECT_MS ?? 0);
      if (crashAfter > 0) {
        // After the client has listed the tools, so the connect completes.
        setTimeout(() => process.exit(4), crashAfter);
      }
    })
    .catch((error) => {
      console.error("Failed to start the lifecycle stdio MCP fixture:", error);
      process.exitCode = 1;
    });
}, delay);
