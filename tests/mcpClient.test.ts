import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP, ROOT } from "../src/config.js";
import { McpClient } from "../src/mcp/client.js";
import { markLoginRequired, readLoginRequired } from "../src/run/linkedinSession.js";
import { mcpCaller, NotAvailable, resolveListings } from "../src/sources/listingLink.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/** A saved LinkedIn session in a temp folder, so no test reads the real one. */
function session(over: { loginAt?: string } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), "jev-caller-session-"));
  const authRoot = path.join(base, "auth");
  mkdirSync(path.join(authRoot, "profile"), { recursive: true });
  writeFileSync(path.join(authRoot, "profile", "Preferences"), "{}");
  writeFileSync(path.join(authRoot, "cookies.json"), JSON.stringify([{ name: "li_at", value: "made-up" }]));
  writeFileSync(path.join(authRoot, "source-state.json"), JSON.stringify({ version: 1, created_at: over.loginAt ?? "2026-10-25T00:00:00Z", login_generation: "test-login" }));
  return { authRoot, backupRoot: path.join(base, "backup"), dataDir: path.join(base, "data") };
}

const fake = (mode: string) => ({ command: process.execPath, args: [fileURLToPath(new URL("./helpers/fakeMcpServer.mjs", import.meta.url)), mode] });

describe("the LinkedIn fork's start command", () => {
  it("uses --project and python -m so the child keeps the caller's working directory", () => {
    const args = [...MCP.linkedin.args];
    expect(args).toContain("--project");
    expect(args).not.toContain("--directory");
    expect(args.indexOf("python")).toBeGreaterThan(-1);
    expect(args.indexOf("python")).toBeLessThan(args.indexOf("-m"));
    expect(args[args.indexOf("-m") + 1]).toBe("linkedin_mcp_server");
  });
});

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
    const caller = mcpCaller(undefined, session());
    try {
      await caller.call("linkedin", "apply_to_job", { job_id: "4252026496" });
      expect(started).toHaveBeenCalledWith(MCP.linkedin, { startupMs: MCP.startupMs, name: "the linkedin MCP server", cwd: ROOT });
      expect(callTool).toHaveBeenCalledWith("apply_to_job", { job_id: "4252026496" }, MCP.callMs);
    } finally {
      caller.close();
      started.mockRestore();
    }
  });

  it("bounds a call by the timeout it is given", async () => {
    const callTool = vi.fn(async () => "{}");
    const started = vi.spyOn(McpClient, "start").mockResolvedValueOnce({ callTool, close: () => {} } as unknown as McpClient);
    const caller = mcpCaller(undefined, session());
    try {
      await caller.call("linkedin", "apply_to_job", { job_id: "4252026496" }, MCP.applyCallMs);
      expect(callTool).toHaveBeenCalledWith("apply_to_job", { job_id: "4252026496" }, MCP.applyCallMs);
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

describe("the LinkedIn server is asked only while its session can be used", () => {
  it("is not started while a login flag stands, and the flag is left as it was", async () => {
    const dirs = session({ loginAt: "2026-10-24T00:00:00Z" });
    markLoginRequired("Sign in", dirs.dataDir);
    const flag = readLoginRequired(dirs.dataDir);
    const started = vi.spyOn(McpClient, "start");
    started.mockClear();
    const lines: string[] = [];
    const caller = mcpCaller((line) => lines.push(line), dirs);
    try {
      await expect(caller.call("linkedin", "get_job_apply_url", { job_id: "4252026496" })).rejects.toBeInstanceOf(NotAvailable);
      await expect(caller.call("linkedin", "get_job_apply_url", { job_id: "4252026497" })).rejects.toBeInstanceOf(NotAvailable);
      expect(started).not.toHaveBeenCalled();
      expect(readLoginRequired(dirs.dataDir)).toEqual(flag);
      expect(lines.filter((l) => l.includes("LinkedIn is not asked"))).toHaveLength(1);
    } finally {
      caller.close();
    }
  });

  it("leaves a flag when the saved session is not usable, and starts nothing", async () => {
    const dirs = session();
    rmSync(path.join(dirs.authRoot, "cookies.json"));
    const started = vi.spyOn(McpClient, "start");
    started.mockClear();
    const caller = mcpCaller(undefined, dirs);
    try {
      await expect(caller.call("linkedin", "get_job_apply_url", { job_id: "4252026496" })).rejects.toThrow(/cookies\.json is missing/);
      expect(started).not.toHaveBeenCalled();
      expect(readLoginRequired(dirs.dataDir)).toMatchObject({ reason: "cookies.json is missing" });
    } finally {
      caller.close();
    }
  });

  it("sets the flag when the fork says it needs a sign-in, so the next call is not made", async () => {
    const dirs = session();
    const callTool = vi.fn(async () => {
      throw new Error("the linkedin MCP server reported an error for get_job_apply_url: A LinkedIn login window is open and login is still in progress.");
    });
    const started = vi.spyOn(McpClient, "start").mockResolvedValueOnce({ callTool, close: () => {} } as unknown as McpClient);
    const caller = mcpCaller(undefined, dirs);
    try {
      await expect(caller.call("linkedin", "get_job_apply_url", { job_id: "4252026496" })).rejects.toBeInstanceOf(NotAvailable);
      expect(readLoginRequired(dirs.dataDir)).toMatchObject({ reason: "login window" });
      await expect(caller.call("linkedin", "get_job_apply_url", { job_id: "4252026497" })).rejects.toBeInstanceOf(NotAvailable);
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      caller.close();
      started.mockRestore();
    }
  });

  it("does not take a sign-in reply for an answer about the posting", async () => {
    const dirs = session();
    const callTool = vi.fn(async () => JSON.stringify({ error_type: "authentication_started", error_message: "Sign in to continue" }));
    const started = vi.spyOn(McpClient, "start").mockResolvedValueOnce({ callTool, close: () => {} } as unknown as McpClient);
    const caller = mcpCaller(undefined, dirs);
    try {
      await expect(caller.call("linkedin", "get_job_apply_url", { job_id: "4252026496" })).rejects.toBeInstanceOf(NotAvailable);
      expect(readLoginRequired(dirs.dataDir)).not.toBeNull();
    } finally {
      caller.close();
      started.mockRestore();
    }
  });

  it("does not keep a login failure as \"no link\" in the answers file", async () => {
    const dirs = session();
    markLoginRequired("Sign in", dirs.dataDir);
    const cacheFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jev-links-")), "links.json");
    const caller = mcpCaller(undefined, dirs);
    try {
      const found = await resolveListings([{ id: "x", url: "https://www.linkedin.com/jobs/view/4252026496" }], { call: caller.call, country: "USA", cacheFile });
      expect(found.size).toBe(0);
      const { loadListingLinks } = await import("../src/sources/listingLink.js");
      expect(loadListingLinks(cacheFile)).toEqual({});
    } finally {
      caller.close();
    }
  });

  it("leaves the Indeed server alone whatever the LinkedIn flag says", async () => {
    const dirs = session({ loginAt: "2026-10-24T00:00:00Z" });
    markLoginRequired("Sign in", dirs.dataDir);
    const callTool = vi.fn(async () => "{}");
    const started = vi.spyOn(McpClient, "start").mockResolvedValueOnce({ callTool, close: () => {} } as unknown as McpClient);
    const caller = mcpCaller(undefined, dirs);
    try {
      await expect(caller.call("indeed", "indeed_get_job_detail", { job_key: "5f2a9c1b7d3e4a60", country: "United States" })).resolves.toBe("{}");
    } finally {
      caller.close();
      started.mockRestore();
    }
  });
});
