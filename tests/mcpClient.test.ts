import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP, ROOT } from "../src/config.js";
import { McpClient } from "../src/mcp/client.js";
import { mcpCaller, resolveListings } from "../src/sources/listingLink.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const fake = (mode: string) => ({ command: process.execPath, args: [fileURLToPath(new URL("./helpers/fakeMcpServer.mjs", import.meta.url)), mode] });

describe("the MCP client", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  it("starts a server in the folder it is given", async () => {
    const client = await McpClient.start(fake("ok"), { startupMs: 5_000, name: "fake", cwd: ROOT });
    try {
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ cwd: ROOT });
    } finally {
      client.close();
    }
  });

  it("calls the tool it is given, not a fixed one", async () => {
    const callTool = vi.fn(async () => "{}");
    const started = vi.spyOn(McpClient, "start").mockResolvedValueOnce({ callTool, close: () => {} } as unknown as McpClient);
    const caller = mcpCaller();
    try {
      await caller.call("linkedin", "apply_to_job", { job_id: "4252026496" });
      expect(started).toHaveBeenCalledWith(MCP.linkedin, { startupMs: MCP.startupMs, name: "the linkedin MCP server", cwd: ROOT });
      expect(callTool).toHaveBeenCalledWith("apply_to_job", { job_id: "4252026496" }, MCP.callMs);
    } finally {
      caller.close();
      started.mockRestore();
    }
  });

  it("asks each board for its read tool", async () => {
    const cacheFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jev-mcp-")), "links.json");
    const asked: { board: string; tool: string }[] = [];
    const call = async (board: string, tool: string) => {
      asked.push({ board, tool });
      return "nothing";
    };
    await resolveListings(
      [
        { id: "li", url: "https://www.linkedin.com/jobs/view/4252026496" },
        { id: "in", url: "https://www.indeed.com/viewjob?jk=5f2a9c1b7d3e4a60" },
      ],
      { call: call as never, country: "USA", cacheFile, dry: true },
    );
    expect(asked).toEqual([
      { board: "linkedin", tool: "get_job_apply_url" },
      { board: "indeed", tool: "indeed_get_job_detail" },
    ]);
  });
});
