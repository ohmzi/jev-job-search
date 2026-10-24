import { describe, expect, it } from "vitest";
import { MCP } from "../src/config.js";
import { applyOnLinkedIn, McpApplyError, type McpApplyResult } from "../src/sources/linkedinApply.js";
import type { ToolCall } from "../src/sources/listingLink.js";

const caller = (reply: string | (() => Promise<string>)) => {
  const calls: { board: string; tool: string; args: Record<string, unknown>; timeoutMs: number | undefined }[] = [];
  const call = async (board: string, tool: string, args: Record<string, unknown>, timeoutMs?: number) => {
    calls.push({ board, tool, args, timeoutMs });
    return typeof reply === "string" ? reply : reply();
  };
  return { calls, call: call as ToolCall };
};

describe("applying through the LinkedIn MCP", () => {
  it("parses an applied result and its learned answers", async () => {
    const reply = JSON.stringify({
      url: "https://www.linkedin.com/jobs/view/4252026496",
      status: "applied",
      message: "Application sent",
      project: "jev-android-tx",
      learned: [{ question: "Do you have 5+ years of Android experience?", answer: "Yes", options: ["Yes", "No"], required: true }],
      unanswered: [],
    });
    const c = caller(reply);
    const result = await applyOnLinkedIn("4252026496", { call: c.call });
    expect(c.calls).toEqual([{ board: "linkedin", tool: MCP.linkedin.tools.apply, args: { job_id: "4252026496" }, timeoutMs: undefined }]);
    expect(result).toEqual({
      status: "applied",
      message: "Application sent",
      project: "jev-android-tx",
      learned: [{ question: "Do you have 5+ years of Android experience?", answer: "Yes", options: ["Yes", "No"], required: true }],
      unanswered: [],
    } satisfies McpApplyResult);
  });

  it("reads the questions it could not answer", async () => {
    const reply = JSON.stringify({
      status: "blocked",
      message: "One field was left unanswered",
      unanswered: [{ label: "Expected salary (USD)", kind: "text", options: [], required: true }],
    });
    const result = await applyOnLinkedIn("4252026496", { call: caller(reply).call });
    expect(result.status).toBe("blocked");
    expect(result.unanswered).toEqual([{ label: "Expected salary (USD)", kind: "text", options: [], required: true }]);
  });

  it("defaults learned and unanswered to empty when the reply omits them", async () => {
    const result = await applyOnLinkedIn("4252026496", { call: caller('{"status":"already_applied","message":"Already applied"}').call });
    expect(result).toEqual({ status: "already_applied", message: "Already applied", learned: [], unanswered: [] });
    expect("project" in result).toBe(false);
  });

  it("an unreadable reply is a failure, not an application", async () => {
    await expect(applyOnLinkedIn("4252026496", { call: caller("not json").call })).rejects.toThrow(McpApplyError);
  });

  it("does not take a status it does not know for an application", async () => {
    await expect(applyOnLinkedIn("4252026496", { call: caller('{"status":"maybe","message":"?"}').call })).rejects.toThrow(McpApplyError);
  });

  it("carries only the first 200 characters of a reply it cannot read", async () => {
    const text = "z".repeat(300);
    const err = await applyOnLinkedIn("4252026496", { call: caller(text).call }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpApplyError);
    expect((err as Error).message).toContain("z".repeat(200));
    expect((err as Error).message).not.toContain("z".repeat(201));
  });

  it("gives up on a call that runs past callMs", async () => {
    const never = () => new Promise<string>(() => {});
    const c = caller(never);
    const err = await applyOnLinkedIn("4252026496", { call: c.call, callMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpApplyError);
    expect((err as Error).message).toMatch(/did not answer/);
    // The same bound reaches the transport, which otherwise cuts every call at its own default.
    expect(c.calls[0]?.timeoutMs).toBe(20);
  });
});
