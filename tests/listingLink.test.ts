import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobId } from "../src/jobs/normalize.js";
import { McpClient } from "../src/mcp/client.js";
import { employerLinkIn, linksIn, listingOf, loadListingLinks, resolveListings, withEmployerLink } from "../src/sources/listingLink.js";

const fake = (mode: string) => ({ command: process.execPath, args: [fileURLToPath(new URL("./helpers/fakeMcpServer.mjs", import.meta.url)), mode] });

describe("the MCP client", () => {
  it("does the handshake, calls a tool and returns its text, ignoring log lines on standard output", async () => {
    const client = await McpClient.start(fake("ok"), { startupMs: 5_000, name: "fake" });
    try {
      const text = await client.callTool("get_job_apply_url", { job_id: "123456" }, 5_000);
      expect(JSON.parse(text)).toMatchObject({ tool: "get_job_apply_url", args: { job_id: "123456" } });
    } finally {
      client.close();
    }
  });
  it("throws when the tool reports an error", async () => {
    const client = await McpClient.start(fake("error"), { startupMs: 5_000, name: "fake" });
    try {
      await expect(client.callTool("x", {}, 5_000)).rejects.toThrow(/reported an error for x: no such posting/);
    } finally {
      client.close();
    }
  });
  it("gives up on a server that never answers", async () => {
    await expect(McpClient.start(fake("silent"), { startupMs: 300, name: "fake" })).rejects.toThrow(/did not answer initialize/);
  });
  it("says so when the server will not start", async () => {
    await expect(McpClient.start({ command: "jev-no-such-command", args: [] }, { startupMs: 2_000, name: "gone" })).rejects.toThrow(/could not start gone/);
  });
  it("fails a call when the server has quit", async () => {
    const client = await McpClient.start(fake("exit"), { startupMs: 5_000, name: "fake" });
    await new Promise((r) => setTimeout(r, 300));
    await expect(client.callTool("x", {}, 1_000)).rejects.toThrow(/closed|stopped/);
  });
});

describe("which listing a link is", () => {
  it("reads a LinkedIn posting id from the usual link shapes", () => {
    expect(listingOf("https://www.linkedin.com/jobs/view/4252026496")).toEqual({ board: "linkedin", id: "4252026496" });
    expect(listingOf("https://www.linkedin.com/jobs/view/android-engineer-at-acme-4252026496/?trk=x")).toEqual({ board: "linkedin", id: "4252026496" });
    expect(listingOf("https://www.linkedin.com/jobs/search/?currentJobId=4252026496")).toEqual({ board: "linkedin", id: "4252026496" });
    expect(listingOf("https://www.linkedin.com/company/acme")).toBeNull();
  });
  it("reads an Indeed job key from any country site", () => {
    expect(listingOf("https://www.indeed.com/viewjob?jk=5f2a9c1b7d3e4a60")).toEqual({ board: "indeed", id: "5f2a9c1b7d3e4a60" });
    expect(listingOf("https://ca.indeed.com/viewjob?jk=5f2a9c1b7d3e4a60&from=serp")?.board).toBe("indeed");
    expect(listingOf("https://www.indeed.com/jobs?q=android")).toBeNull();
  });
  it("is neither for an employer's own link", () => {
    expect(listingOf("https://boards.greenhouse.io/acme/jobs/123")).toBeNull();
    expect(listingOf("https://evil-indeed.com.example.org/viewjob?jk=5f2a9c1b7d3e4a60")).toBeNull();
  });
});

describe("the employer's link in a reply", () => {
  it("finds a link in JSON text with escaped slashes", () => {
    expect(employerLinkIn('{"apply":"https:\\/\\/boards.greenhouse.io\\/acme\\/jobs\\/123"}')).toBe("https://boards.greenhouse.io/acme/jobs/123");
  });
  it("believes a named apply_url over links in the description", () => {
    const reply = JSON.stringify({ description: "see https://boards.greenhouse.io/other/jobs/1 for more", apply_url: "https://join.acme.com/global/en/job/42/Android?utm_source=INDEED_FEED" });
    expect(employerLinkIn(reply)).toBe("https://join.acme.com/global/en/job/42/Android?utm_source=INDEED_FEED");
    expect(employerLinkIn(JSON.stringify({ apply_url: "https://www.indeed.com/applystart?jk=1" }))).toBeNull();
  });
  it("skips the board's own links and unwraps its redirect", () => {
    const text = "See https://www.linkedin.com/jobs/view/4252026496 or apply at https://www.linkedin.com/safety/go?url=https%3A%2F%2Fjobs.lever.co%2Facme%2F0a1b2c3d-0000-4000-8000-123456789abc.";
    expect(employerLinkIn(text)).toBe("https://jobs.lever.co/acme/0a1b2c3d-0000-4000-8000-123456789abc");
  });
  it("prefers a known application board over another link", () => {
    expect(employerLinkIn("https://acme.com/about https://jobs.ashbyhq.com/acme/0a1b2c3d-0000-4000-8000-123456789abc/application")).toContain("ashbyhq.com");
  });
  it("takes an unknown site only when the link looks like an application", () => {
    expect(employerLinkIn("https://acme.com/about and https://acme.com/news/2026")).toBeNull();
    expect(employerLinkIn("https://acme.com/careers/android-engineer-42")).toBe("https://acme.com/careers/android-engineer-42");
  });
  it("ignores http links and images", () => {
    expect(linksIn("http://acme.com/careers/1 https://acme.com/logo.png")).toEqual([]);
  });
  it("changes the link and the board, and the id follows the link as the queue derives it", () => {
    const j = withEmployerLink({ id: "abc", url: "https://www.indeed.com/viewjob?jk=1", ats: "other" }, "https://boards.greenhouse.io/acme/jobs/123");
    expect(j).toEqual({ id: jobId("https://boards.greenhouse.io/acme/jobs/123"), url: "https://boards.greenhouse.io/acme/jobs/123", ats: "greenhouse" });
  });
});

describe("resolving listings", () => {
  const dir = () => mkdtempSync(path.join(os.tmpdir(), "jev-links-"));
  const jobs = [
    { id: "li", url: "https://www.linkedin.com/jobs/view/4252026496" },
    { id: "in", url: "https://www.indeed.com/viewjob?jk=5f2a9c1b7d3e4a60" },
    { id: "direct", url: "https://boards.greenhouse.io/acme/jobs/9" },
  ];

  it("asks the right server with the right arguments, and keeps the answers", async () => {
    const cacheFile = path.join(dir(), "links.json");
    const asked: { board: string; args: Record<string, unknown> }[] = [];
    const call = async (board: string, _tool: string, args: Record<string, unknown>) => {
      asked.push({ board, args });
      return board === "linkedin" ? "apply: https://boards.greenhouse.io/acme/jobs/123" : "no application link here";
    };
    const found = await resolveListings(jobs, { call: call as never, country: "USA", cacheFile });
    expect(found.get("li")).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(found.has("in")).toBe(false);
    expect(found.has("direct")).toBe(false);
    expect(asked).toEqual([
      { board: "linkedin", args: { job_id: "4252026496" } },
      { board: "indeed", args: { job_key: "5f2a9c1b7d3e4a60", country: "United States" } },
    ]);
    // The second run asks about neither: the link is kept for good and "no link" for hours.
    asked.length = 0;
    const again = await resolveListings(jobs, { call: call as never, country: "USA", cacheFile });
    expect(again.get("li")).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(asked).toEqual([]);
    expect(Object.keys(loadListingLinks(cacheFile)).sort()).toEqual(["indeed:5f2a9c1b7d3e4a60", "linkedin:4252026496"]);
  });

  it("asks again about a listing with no link once the wait is over", async () => {
    const cacheFile = path.join(dir(), "links.json");
    const call = async () => "nothing";
    const t0 = new Date("2026-10-22T08:00:00Z");
    await resolveListings([jobs[1] as (typeof jobs)[number]], { call: call as never, country: "USA", cacheFile, now: t0 });
    let asked = 0;
    const counting = async () => (asked++, "nothing");
    await resolveListings([jobs[1] as (typeof jobs)[number]], { call: counting as never, country: "USA", cacheFile, now: new Date(t0.getTime() + 3_600_000) });
    expect(asked).toBe(0);
    await resolveListings([jobs[1] as (typeof jobs)[number]], { call: counting as never, country: "USA", cacheFile, now: new Date(t0.getTime() + 7 * 3_600_000) });
    expect(asked).toBe(1);
  });

  it("does not keep a failure as an answer", async () => {
    const cacheFile = path.join(dir(), "links.json");
    let asked = 0;
    const call = async () => {
      asked++;
      throw new Error("boom");
    };
    const two = [jobs[0] as (typeof jobs)[number], { id: "li2", url: "https://www.linkedin.com/jobs/view/4252026497" }];
    const found = await resolveListings(two, { call: call as never, country: "USA", cacheFile });
    expect(found.size).toBe(0);
    expect(asked).toBe(2);
    expect(loadListingLinks(cacheFile)).toEqual({});
  });

  it("asks about no more listings than the limit", async () => {
    const cacheFile = path.join(dir(), "links.json");
    let asked = 0;
    const call = async () => (asked++, "nothing");
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `j${i}`, url: `https://www.linkedin.com/jobs/view/42520264${10 + i}` }));
    await resolveListings(many, { call: call as never, country: "USA", cacheFile, limit: 3 });
    expect(asked).toBe(3);
  });

  it("leaves the cache file alone on a dry run", async () => {
    const cacheFile = path.join(dir(), "links.json");
    await resolveListings([jobs[0] as (typeof jobs)[number]], { call: (async () => "https://boards.greenhouse.io/acme/jobs/1") as never, country: "USA", cacheFile, dry: true });
    expect(loadListingLinks(cacheFile)).toEqual({});
  });
});
