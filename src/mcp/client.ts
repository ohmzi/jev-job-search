/**
 * A small MCP client for servers that speak over standard input and output. It starts the server
 * as a child process with the allow-listed environment, does the handshake, and calls tools. It
 * needs no dependency: the protocol here is newline-delimited JSON-RPC.
 *
 * A tool's reply is data. Only its text is returned, and the caller decides what to read from it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { childEnv } from "../config.js";

export type McpServer = { command: string; args: readonly string[] };

const Message = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).default([]),
  isError: z.boolean().optional(),
});

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };

export class McpClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private stderr = "";

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly label: string) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-400);
    });
    child.on("error", (err) => this.fail(new McpError(`could not start ${label}: ${err.message}`)));
    child.on("close", (code) => this.fail(new McpError(`${label} stopped (exit ${String(code)})${this.stderr.trim() ? `: ${this.stderr.trim().slice(-200)}` : ""}`)));
  }

  /** Starts the server and completes the handshake, or throws. */
  static async start(server: McpServer, o: { startupMs: number; name?: string }): Promise<McpClient> {
    const label = o.name ?? server.command;
    const child = spawn(server.command, [...server.args], { stdio: ["pipe", "pipe", "pipe"], env: childEnv() });
    const client = new McpClient(child, label);
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "jev-job-search", version: "1" } }, o.startupMs);
      client.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  /** Calls a tool and returns the text of its reply. A tool that reports an error throws. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const raw = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const parsed = ToolResult.safeParse(raw);
    if (!parsed.success) throw new McpError(`${this.label} answered ${name} in a shape this tool does not read`);
    const text = parsed.data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    if (parsed.data.isError) throw new McpError(`${this.label} reported an error for ${name}: ${text.slice(0, 200)}`);
    return text;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpError(`${this.label} is closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`${this.label} did not answer ${method} in ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        continue; // a server may print a log line on standard output
      }
      const msg = Message.safeParse(json);
      if (!msg.success || typeof msg.data.id !== "number") continue; // a notification or a request from the server
      const pending = this.pending.get(msg.data.id);
      if (!pending) continue;
      this.pending.delete(msg.data.id);
      clearTimeout(pending.timer);
      if (msg.data.error) pending.reject(new McpError(`${this.label}: ${msg.data.error.message}`));
      else pending.resolve(msg.data.result);
    }
  }

  private fail(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.closed = true;
  }
}
