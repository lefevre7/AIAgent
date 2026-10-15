// A bare stdio MCP server that answers tools/list with MCP_RAW_TOOLS (a JSON
// array) exactly as given, malformed tools included, which an SDK server
// would never send. Enough of the protocol for a client to connect and list.
import readline from "node:readline";

const tools = JSON.parse(process.env.MCP_RAW_TOOLS ?? "[]");
// notifications/cancelled received, reported by calling the tool "cancellations".
let cancellations = 0;
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) {
    if (request.method === "notifications/cancelled") {
      cancellations += 1;
    }
    return;
  }
  switch (request.method) {
    case "initialize":
      send({
        id: request.id,
        result: {
          capabilities: { tools: {} },
          protocolVersion: request.params.protocolVersion,
          serverInfo: { name: "raw-tools", version: "1.0.0" }
        }
      });
      return;
    case "tools/list":
      send({ id: request.id, result: { tools } });
      return;
    case "tools/call":
      send({
        id: request.id,
        result: {
          content: [
            {
              text: request.params.name === "cancellations" ? String(cancellations) : `called:${request.params.name}`,
              type: "text"
            }
          ]
        }
      });
      return;
    default:
      send({ error: { code: -32601, message: "Method not found" }, id: request.id });
  }
});
