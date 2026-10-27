import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canFill } from "../src/jobs/fillable.js";
import { jobId, type Job } from "../src/jobs/normalize.js";
import { followListings } from "../src/run/followListings.js";
import { loadQueue, saveQueue, type QueueEntry } from "../src/jobs/queue.js";
import type { Profile } from "../src/profile/schema.js";

const NOW = new Date("2026-10-22T12:00:00");
const entry = (_name: string, url: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  job: { id: jobId(url), source: "jobspy linkedin", company: "Delta", title: "Android Engineer", url, ats: url.includes("linkedin") ? "linkedin" : "other", locations: ["Jersey City, NJ"], postedAt: "2026-10-22", terms: [], sponsorship: "unknown", degrees: [], category: null, easyApply: url.includes("greenhouse") ? false : null } as QueueEntry["job"],
  fit: null,
  preFilterReason: null,
  applyable: false,
  holdUntil: new Date(NOW.getTime() + 6 * 3_600_000).toISOString(),
  status: "in_progress",
  statusReason: null,
  attempts: 1,
  discoveredAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  appliedAt: null,
  notes: null,
  waitingFor: null,
  answers: [],
  replies: [],
  response: null,
  ...over,
});
const profile = { search: { countryIndeed: "USA" } } as unknown as Profile;

const files = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-follow-"));
  return { queueFile: path.join(dir, "queue.json"), rowsFile: path.join(dir, "all.csv"), linksFile: path.join(dir, "links.json") };
};
const caller = (reply: (board: string) => string) => ({ call: async (board: string) => reply(board), close: () => {} });

describe("the apply step following a listing to the employer", () => {
  it("takes a listing to the employer's form, in memory and in the queue", async () => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496");
    const b = entry("b", "https://www.indeed.com/viewjob?jk=5f2a9c1b7d3e4a60");
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a, b] }, f.queueFile);
    const moved = await followListings([a, b], profile, { ...f, now: NOW, quiet: true, listings: caller((board) => (board === "linkedin" ? "https://boards.greenhouse.io/delta/jobs/777" : "no link in this posting")) as never });
    expect(moved).toBe(1);
    expect(a.job.url).toBe("https://boards.greenhouse.io/delta/jobs/777");
    expect(a.job.ats).toBe("greenhouse");
    expect(a.applyable).toBe(true);
    expect(a.holdUntil).toBeNull();
    expect(b.job.url).toBe("https://www.indeed.com/viewjob?jk=5f2a9c1b7d3e4a60");
    expect(b.applyable).toBe(false);
    const saved = loadQueue(f.queueFile).entries;
    // The id follows the link, as the queue derives it on every read, so the run records the result under it.
    expect(a.job.id).toBe(jobId("https://boards.greenhouse.io/delta/jobs/777"));
    expect(saved.find((e) => e.job.id === a.job.id)).toMatchObject({ applyable: true, holdUntil: null, status: "in_progress", job: { url: "https://boards.greenhouse.io/delta/jobs/777" } });
    expect(saved.find((e) => e.job.id === b.job.id)?.applyable).toBe(false);
  });

  it("marks an Easy Apply listing without moving it", async () => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496");
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a] }, f.queueFile);
    const moved = await followListings([a], profile, {
      ...f,
      now: NOW,
      quiet: true,
      listings: caller(() => JSON.stringify({ url: null, apply: { type: "easy_apply" } })) as never,
    });
    expect(moved).toBe(0);
    expect(a.job.url).toBe("https://www.linkedin.com/jobs/view/4252026496");
    expect(a.job.easyApply).toBe(true);
    expect(loadQueue(f.queueFile).entries[0]?.job.easyApply).toBe(true);
  });

  it("changes nothing on disk in a rehearsal", async () => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496");
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a] }, f.queueFile);
    await followListings([a], profile, { ...f, dry: true, now: NOW, quiet: true, listings: caller(() => "https://boards.greenhouse.io/delta/jobs/777") as never });
    expect(a.job.url).toBe("https://boards.greenhouse.io/delta/jobs/777");
    expect(loadQueue(f.queueFile).entries[0]?.job.url).toBe("https://www.linkedin.com/jobs/view/4252026496");
  });

  it("puts an easy apply listing in the apply run with no employer link", async () => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496");
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a] }, f.queueFile);
    const moved = await followListings([a], profile, { ...f, now: NOW, quiet: true, listings: caller(() => JSON.stringify({ apply: { type: "easy_apply" } })) as never });
    expect(moved).toBe(0);
    expect(a.applyable).toBe(true);
    expect(a.job.url).toBe("https://www.linkedin.com/jobs/view/4252026496");
    expect(a.job.easyApply).toBe(true);
    expect(a.holdUntil).toBeNull();
    const saved = loadQueue(f.queueFile).entries;
    expect(saved.find((e) => e.job.id === a.job.id)).toMatchObject({ applyable: true, holdUntil: null, status: "in_progress", job: { url: "https://www.linkedin.com/jobs/view/4252026496", easyApply: true } });
  });

  it("an external posting is not routed to the mcp", async () => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496");
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a] }, f.queueFile);
    const moved = await followListings([a], profile, { ...f, now: NOW, quiet: true, listings: caller(() => JSON.stringify({ apply: { type: "external", url: "https://boards.greenhouse.io/x/1" } })) as never });
    expect(moved).toBe(1);
    expect(a.job.url).toBe("https://boards.greenhouse.io/x/1");
    expect(a.job.ats).toBe("greenhouse");
    expect(a.job.easyApply).toBe(false);
    expect(a.applyable).toBe(canFill(a.job as unknown as Job));
    expect(a.holdUntil).toBeNull();
    expect(loadQueue(f.queueFile).entries[0]?.job.url).toBe("https://boards.greenhouse.io/x/1");
  });

  it.each(["external", "unknown"])("a %s posting with no employer link stays off the apply run", async (type) => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496", { applyable: true });
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a] }, f.queueFile);
    const moved = await followListings([a], profile, { ...f, now: NOW, quiet: true, listings: caller(() => JSON.stringify({ apply: { type } })) as never });
    expect(moved).toBe(0);
    expect(a.applyable).toBe(false);
    expect(a.job.url).toBe("https://www.linkedin.com/jobs/view/4252026496");
    expect(a.job.easyApply).toBe(type === "external" ? false : null);
    expect(loadQueue(f.queueFile).entries[0]).toMatchObject({ applyable: false, job: { url: "https://www.linkedin.com/jobs/view/4252026496", easyApply: type === "external" ? false : null } });
  });

  it("an unresolved posting is not marked for the mcp", async () => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496", { applyable: true });
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a] }, f.queueFile);
    const moved = await followListings([a], profile, { ...f, now: NOW, quiet: true, listings: caller(() => "no link in this posting") as never });
    expect(moved).toBe(0);
    expect(a.applyable).toBe(false);
    expect(a.job.easyApply).toBeNull();
    expect(loadQueue(f.queueFile).entries[0]?.job.easyApply).toBeNull();
  });

  it("never marks an applied or unconfirmed easy apply listing", async () => {
    const f = files();
    const a = entry("a", "https://www.linkedin.com/jobs/view/4252026496", { status: "applied" });
    const b = entry("b", "https://www.linkedin.com/jobs/view/4252026497", { status: "submission_unknown" });
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a, b] }, f.queueFile);
    await followListings([a, b], profile, { ...f, now: NOW, quiet: true, listings: caller(() => JSON.stringify({ apply: { type: "easy_apply" } })) as never });
    expect(a.applyable).toBe(false);
    expect(a.holdUntil).not.toBeNull();
    expect(a.job.easyApply).toBeNull();
    expect(b.applyable).toBe(false);
    expect(b.holdUntil).not.toBeNull();
    expect(b.job.easyApply).toBeNull();
    expect(loadQueue(f.queueFile).entries.map((e) => e.applyable)).toEqual([false, false]);
  });

  it("asks nothing for a job that already has an employer's link, and nothing when listings are off", async () => {
    const f = files();
    const direct = entry("d", "https://boards.greenhouse.io/delta/jobs/1", { applyable: true, holdUntil: null });
    let asked = 0;
    const counting = { call: async () => (asked++, "x"), close: () => {} };
    expect(await followListings([direct], profile, { ...f, quiet: true, listings: counting as never })).toBe(0);
    expect(asked).toBe(0);
    const listing = entry("a", "https://www.linkedin.com/jobs/view/4252026496");
    expect(await followListings([listing], profile, { ...f, quiet: true, listings: false })).toBe(0);
    expect(asked).toBe(0);
  });
});
