// A stand-in MCP server over standard input and output, for the client's tests.
// mode "ok": answers a tool call with a posting whose reply holds an employer link.
// mode "error": reports a tool error. mode "silent": reads and never answers.
// mode "exit": quits after the handshake.
import readline from "node:readline";

const mode = process.argv[2] ?? "ok";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    if (mode === "silent") return;
    console.log("a log line that is not JSON-RPC");
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  }
  if (msg.method === "notifications/initialized") {
    if (mode === "exit") process.exit(0);
    return;
  }
  if (msg.method === "tools/call") {
    if (mode === "error") return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "no such posting" }] } });
    if (mode === "silent") return;
    const { name, arguments: args } = msg.params;
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: JSON.stringify({ tool: name, args, apply: "https:\\/\\/boards.greenhouse.io\\/acme\\/jobs\\/123?gh_src=x" }) }] },
    });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
});
