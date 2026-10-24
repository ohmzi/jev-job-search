import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ageHeldEntries, isRecent, localDate, recentFirst } from "../src/jobs/recency.js";
import { dedupeJobspy, locationWanted, mapJobspy, postedOf, titleWanted } from "../src/sources/jobspy.js";
import { mergeHourly, runHourly } from "../src/run/hourly.js";
import { buildRecent } from "../src/report/recent.js";
import { pickJobs } from "../src/run/pipeline.js";
import { loadQueue, saveQueue, type QueueEntry } from "../src/jobs/queue.js";
import { hourlyAgentPlist, hourlyServiceUnit, hourlyTimerUnit, hourlyUnitFiles, installHourlySchedule } from "../src/run/schedule.js";
import type { Profile } from "../src/profile/schema.js";
import type { Job } from "../src/jobs/normalize.js";

const NOW = new Date("2026-10-22T12:00:00");
/** No site is known to be walled: this keeps the test off the machine's learned site notes. */
const noWalls = () => false;

const job = (over: Partial<Job> = {}): Job => ({
  id: "job-1",
  source: "jobspy indeed",
  company: "Acme",
  title: "Android Engineer",
  url: "https://boards.greenhouse.io/acme/jobs/123",
  ats: "greenhouse",
  locations: ["Jersey City, NJ"],
  postedAt: "2026-10-22",
  postedAtExact: null,
  terms: [],
  sponsorship: "unknown",
  degrees: [],
  category: null,
  ...over,
});

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  job: job() as QueueEntry["job"],
  fit: null,
  preFilterReason: null,
  applyable: true,
  holdUntil: null,
  status: "queued",
  statusReason: null,
  attempts: 0,
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

const search = {
  portal: "android-nj",
  titleInclude: ["(android|mobile|ios|kotlin)", "(developer|engineer|software|programmer)"],
  titleExclude: ["designer|manager|sales|recruit|marketing|mdm|forensics"],
  terms: ["android developer"],
  sites: ["indeed", "linkedin"] as ("indeed" | "linkedin")[],
  countryIndeed: "USA",
  resultsWanted: 50,
  hoursOld: 1,
  maxQueries: 1,
  gapMs: 0,
  minuteOffset: 0,
  locations: [{ query: "New Jersey, USA", distance: 40, accept: ["\\bNJ\\b|New Jersey|New York|Jersey City"] }],
  excludeRemoteOnly: true,
  excludeCompanies: [],
};

const profile = (over: Partial<Profile> = {}): Profile =>
  ({
    search,
    workAuthorization: {
      citizenships: ["United States"],
      authorizedCountries: ["United States"],
      requiresSponsorshipElsewhere: true,
      statement: "Authorized in the United States.",
    },
    ...over,
  }) as unknown as Profile;

describe("the last 12 hours rule", () => {
  it("keeps a job first seen inside the window with a fresh posted date", () => {
    expect(isRecent(entry({ discoveredAt: new Date(NOW.getTime() - 3_600_000).toISOString() }), NOW)).toBe(true);
  });
  it("ages a job out at twelve hours", () => {
    expect(isRecent(entry({ discoveredAt: new Date(NOW.getTime() - 12 * 3_600_000).toISOString() }), NOW)).toBe(false);
  });
  it("leaves out an old posting even when it was just found", () => {
    expect(isRecent(entry({ job: { ...job(), postedAt: "2026-10-20" } as QueueEntry["job"] }), NOW)).toBe(false);
  });
  it("uses first-seen time when the board gave no posted date", () => {
    expect(isRecent(entry({ job: { ...job(), postedAt: null } as QueueEntry["job"] }), NOW)).toBe(true);
  });
  it("puts recent entries first without changing either order", () => {
    const recent = entry({ job: { ...job(), id: "recent" } as QueueEntry["job"] });
    const old = entry({ job: { ...job(), id: "old" } as QueueEntry["job"], discoveredAt: "2026-10-20T00:00:00Z" });
    expect(recentFirst([old, recent], NOW).map((e) => e.job.id)).toEqual(["recent", "old"]);
  });
  it("moves only a held, queued job that is past its window", () => {
    const old = new Date(NOW.getTime() - 13 * 3_600_000).toISOString();
    const held = entry({ applyable: false, discoveredAt: old, holdUntil: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const fillable = entry({ applyable: true, discoveredAt: old });
    const sent = entry({ applyable: false, status: "applied", discoveredAt: old, holdUntil: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const chosen = entry({ applyable: false, discoveredAt: old, holdUntil: null });
    const fresh = entry({ applyable: false, holdUntil: new Date(NOW.getTime() + 3_600_000).toISOString() });
    const q = { entries: [held, fillable, sent, chosen, fresh] };
    const changed = ageHeldEntries(q, NOW);
    expect(changed).toHaveLength(1);
    expect(held.status).toBe("needs_review");
    expect(held.statusReason).toMatch(/12 hours/);
    expect(held.holdUntil).toBeNull();
    expect(fillable.status).toBe("queued");
    expect(sent.status).toBe("applied");
    expect(chosen.status).toBe("queued");
    expect(fresh.status).toBe("queued");
  });
  it("uses the machine's own calendar date", () => {
    expect(localDate(NOW)).toBe("2026-10-22");
  });
});

describe("jobspy records", () => {
  it("reads a date alone as a calendar day, and a timestamp as an exact moment", () => {
    expect(postedOf("2026-10-22")).toEqual({ postedAt: "2026-10-22", postedAtExact: null });
    expect(postedOf("2026-10-22T14:30:00").postedAtExact).toBe(new Date("2026-10-22T14:30:00").toISOString());
    expect(postedOf(null)).toEqual({ postedAt: null, postedAtExact: null });
    // pandas writes the column as a number, in milliseconds.
    expect(postedOf(1761000000000).postedAt).toBe("2025-10-20");
    expect(postedOf(1761000000).postedAt).toBe("2025-10-20");
    // Midnight is how a date-only column is written, so it is not shown as an exact time.
    expect(postedOf(1760918400000)).toEqual({ postedAt: "2025-10-20", postedAtExact: null });
  });
  it("maps a raw row, preferring the employer's own link", () => {
    const j = mapJobspy({
      site: "indeed",
      title: "Android Engineer",
      company: "Acme",
      location: "Jersey City, NJ",
      job_url: "https://www.indeed.com/viewjob?jk=1",
      job_url_direct: "https://boards.greenhouse.io/acme/jobs/123",
      date_posted: "2026-10-22",
    });
    expect(j?.url).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(j?.ats).toBe("greenhouse");
    expect(j?.source).toBe("jobspy indeed");
    expect(j?.postedAt).toBe("2026-10-22");
  });
  it("drops a row without a title, company or link", () => {
    expect(mapJobspy({ title: "", company: "Acme", job_url: "https://x/1" })).toBeNull();
  });
  it("matches the portal's role family and leaves out the roles it names", () => {
    expect(titleWanted("Senior Android Engineer", search)).toBe(true);
    expect(titleWanted("Android Product Manager", search)).toBe(false);
    expect(titleWanted("Full Stack Engineer", search)).toBe(false);
  });
  it("accepts a city in the area even when the posting is remote there, and refuses remote-only", () => {
    expect(locationWanted(["Jersey City, NJ (Remote)"], search)).toBe(true);
    expect(locationWanted(["Remote"], search)).toBe(false);
    expect(locationWanted(["USA"], search)).toBe(false);
    expect(locationWanted(["Austin, TX"], search)).toBe(false);
  });
  it("keeps one record per job and prefers the one with an employer form", () => {
    const board = job({ id: "a", url: "https://www.linkedin.com/jobs/view/1", ats: "linkedin" });
    const direct = job({ id: "b", url: "https://boards.greenhouse.io/acme/jobs/123", ats: "greenhouse" });
    const out = dedupeJobspy([board, direct]);
    expect(out).toHaveLength(1);
    expect(out[0]?.ats).toBe("greenhouse");
  });
});

describe("putting hourly finds in the queue", () => {
  it("queues a job the tool can fill and holds one it cannot", () => {
    const linkedin = job({ id: "li", company: "Beta", url: "https://www.linkedin.com/jobs/view/1", ats: "linkedin" });
    const r = mergeHourly([], [job(), linkedin], profile(), NOW, noWalls);
    expect(r.added).toBe(2);
    expect(r.held).toBe(1);
    const fresh = r.entries.find((e) => e.job.id === job().id);
    const held = r.entries.find((e) => e.job.id === "li");
    expect(fresh?.status).toBe("queued");
    expect(fresh?.applyable).toBe(true);
    expect(fresh?.fit).toBeNull();
    expect(held?.status).toBe("queued");
    expect(held?.applyable).toBe(false);
    expect(held?.holdUntil).toBeTruthy();
  });
  it("holds a board the tool has not read instead of skipping it", () => {
    const icims = job({ id: "icims", url: "https://acme.icims.com/jobs/123", ats: "icims" });
    const r = mergeHourly([], [icims], profile(), NOW, noWalls);
    expect(r.skipped).toBe(0);
    expect(r.held).toBe(1);
    expect(r.entries[0]?.status).toBe("queued");
    expect(r.entries[0]?.applyable).toBe(false);
  });
  it("hands an old board-only listing to the person at once", () => {
    const old = job({ id: "old", url: "https://www.linkedin.com/jobs/view/2", ats: "linkedin", postedAt: "2026-10-20" });
    const r = mergeHourly([], [old], profile(), NOW, noWalls);
    expect(r.entries[0]?.status).toBe("needs_review");
    expect(r.entries[0]?.statusReason).toMatch(/12 hours/);
  });
  it("keeps an existing job's status and first-seen time", () => {
    const before = entry({ status: "needs_review", discoveredAt: "2026-10-22T11:00:00Z" });
    const r = mergeHourly([before], [job({ company: "Acme Renamed" })], profile(), NOW, noWalls);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
    expect(r.entries[0]?.status).toBe("needs_review");
    expect(r.entries[0]?.discoveredAt).toBe("2026-10-22T11:00:00Z");
    expect(r.entries[0]?.job.company).toBe("Acme Renamed");
  });
  it("does not queue a job that was already sent under another location", () => {
    const sent = entry({ job: { ...job(), locations: ["Newark, NJ"] } as QueueEntry["job"], status: "applied" });
    const found = job({ id: "other", url: "https://www.linkedin.com/jobs/view/8", ats: "linkedin", locations: ["Jersey City, NJ"] });
    const r = mergeHourly([sent], [found], profile(), NOW, noWalls);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
    expect(r.entries[0]?.status).toBe("applied");
  });
  it("never moves a sent application to a different link", () => {
    const sent = entry({ status: "applied", appliedAt: "2026-10-22T10:00:00Z" });
    const other = job({ id: "other", url: "https://www.linkedin.com/jobs/view/9", ats: "linkedin" });
    const r = mergeHourly([sent], [other], profile(), NOW, noWalls);
    expect(r.entries[0]?.job.url).toBe(sent.job.url);
    expect(r.entries[0]?.status).toBe("applied");
  });
});

describe("the Last 12 hours rows", () => {
  it("shows recent jobs and leaves out the rest", () => {
    const rows = buildRecent(
      [
        entry({ job: { ...job(), company: "New" } as QueueEntry["job"] }),
        entry({ job: { ...job(), id: "old", company: "Old" } as QueueEntry["job"], discoveredAt: "2026-10-20T00:00:00Z" }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.company)).toEqual(["New"]);
    expect(rows[0]?.why).toBe("new find");
  });
  it("never shows a job again once it was sent", () => {
    const applied = entry({ status: "applied", appliedAt: NOW.toISOString() });
    const unknown = entry({ job: { ...job(), id: "u" } as QueueEntry["job"], status: "submission_unknown" });
    expect(buildRecent([applied, unknown], NOW)).toHaveLength(0);
  });
  it("says when the posted time is unknown or the board cannot be filled", () => {
    const unknown = entry({ job: { ...job(), postedAt: null } as QueueEntry["job"] });
    const held = entry({ job: { ...job(), id: "h", url: "https://www.linkedin.com/jobs/view/3", ats: "linkedin" } as QueueEntry["job"], applyable: false });
    const rows = buildRecent([unknown, held], NOW);
    expect(rows.some((r) => r.why === "posted time unknown")).toBe(true);
    expect(rows.some((r) => /cannot fill/.test(r.why))).toBe(true);
  });
});

describe("apply order", () => {
  it("takes recent jobs first, and a board-only listing is tried rather than skipped", () => {
    const oldHigh = entry({ job: { ...job(), id: "old-high" } as QueueEntry["job"], fit: { score: 0.9, decision: "apply", skipReason: null, reasons: [], components: {}, locationTier: "us", answers: {} }, discoveredAt: "2026-10-20T00:00:00Z" });
    const newLow = entry({ job: { ...job(), id: "new-low" } as QueueEntry["job"], fit: { score: 0.2, decision: "apply", skipReason: null, reasons: [], components: {}, locationTier: "us", answers: {} } });
    const held = entry({ job: { ...job(), id: "held" } as QueueEntry["job"], applyable: false });
    const picked = pickJobs([oldHigh, newLow, held], [], { count: 2, dry: true, now: NOW });
    expect(picked.picked.map((e) => e.job.id)).toEqual(["new-low", "held"]);
  });
});

describe("one hourly run", () => {
  it("ages held jobs and writes new finds without touching the network", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-hourly-"));
    const queueFile = path.join(dir, "queue.json");
    const rowsFile = path.join(dir, "all.csv");
    const stateFile = path.join(dir, "hourly.json");
    const old = new Date(NOW.getTime() - 13 * 3_600_000).toISOString();
    saveQueue({
      version: 1,
      generatedAt: old,
      entries: [entry({ job: { ...job(), id: "held", url: "https://www.linkedin.com/jobs/view/7", ats: "linkedin" } as QueueEntry["job"], applyable: false, discoveredAt: old, holdUntil: old })],
    }, queueFile);
    const rows = JSON.stringify([
      { site: "indeed", title: "Android Engineer", company: "Gamma", location: "Jersey City, NJ", job_url: "https://www.indeed.com/viewjob?jk=1", job_url_direct: "https://boards.greenhouse.io/gamma/jobs/123", date_posted: "2026-10-22" },
    ]);
    const summary = await runHourly(profile(), {
      now: NOW,
      queueFile,
      rowsFile,
      stateFile,
      runner: () => ({ ok: true, stdout: rows, error: "" }),
    });
    expect(summary.aged).toBe(1);
    expect(summary.added).toBe(1);
    const q = loadQueue(queueFile);
    expect(q.entries.find((e) => e.job.company === "Acme")?.status).toBe("needs_review");
    expect(q.entries.find((e) => e.job.ats === "greenhouse")?.status).toBe("queued");
    expect(readFileSync(rowsFile, "utf8")).toContain("Gamma");
  });
});

describe("board listings that lead to an employer form", () => {
  const setup = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-hourly-links-"));
    return { queueFile: path.join(dir, "queue.json"), rowsFile: path.join(dir, "all.csv"), stateFile: path.join(dir, "hourly.json"), cacheFile: path.join(dir, "links.json") };
  };
  const rows = JSON.stringify([{ site: "linkedin", title: "Android Engineer", company: "Delta", location: "Jersey City, NJ", job_url: "https://www.linkedin.com/jobs/view/4252026496", date_posted: "2026-10-22" }]);

  it("queues a listing for filling when the board's MCP gives the employer's link", async () => {
    const f = setup();
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [] }, f.queueFile);
    const asked: unknown[] = [];
    const listings = { call: async (board: string, _tool: string, args: Record<string, unknown>) => (asked.push([board, args]), "apply at https://boards.greenhouse.io/delta/jobs/777"), close: () => {} };
    const summary = await runHourly(profile(), { now: NOW, ...f, runner: () => ({ ok: true, stdout: rows, error: "" }), linksFile: f.cacheFile, listings: listings as never });
    expect(asked).toEqual([["linkedin", { job_id: "4252026496" }]]);
    expect(summary).toMatchObject({ added: 1, held: 0 });
    const e = loadQueue(f.queueFile).entries[0];
    expect(e?.status).toBe("queued");
    expect(e?.applyable).toBe(true);
    expect(e?.holdUntil).toBeNull();
    expect(e?.job.url).toBe("https://boards.greenhouse.io/delta/jobs/777");
    expect(e?.job.ats).toBe("greenhouse");
  });

  it("holds the listing for the person when the MCP has no link, and Chrome gets the page later", async () => {
    const f = setup();
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [] }, f.queueFile);
    const listings = { call: async () => "no application link in this posting", close: () => {} };
    const summary = await runHourly(profile(), { now: NOW, ...f, runner: () => ({ ok: true, stdout: rows, error: "" }), linksFile: f.cacheFile, listings: listings as never });
    expect(summary).toMatchObject({ added: 1, held: 1 });
    const e = loadQueue(f.queueFile).entries[0];
    expect(e?.applyable).toBe(false);
    expect(e?.job.url).toBe("https://www.linkedin.com/jobs/view/4252026496");
    expect(e?.holdUntil).not.toBeNull();
  });

  it("starts no MCP server when listings are off", async () => {
    const f = setup();
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [] }, f.queueFile);
    const summary = await runHourly(profile(), { now: NOW, ...f, runner: () => ({ ok: true, stdout: rows, error: "" }), linksFile: f.cacheFile, listings: false });
    expect(summary.held).toBe(1);
  });
});

describe("the hourly schedule", () => {
  it("writes a LaunchAgent at a minute of every hour", () => {
    const plist = hourlyAgentPlist({ portal: "android-nj", node: "/usr/bin/node", root: "/repo", minute: 20, searchPath: "/usr/bin:/bin", log: "/repo/data/runs/hourly.log" });
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Minute</key><integer>20</integer>");
    expect(plist).toContain("hourly");
  });
  it("writes a systemd service and a timer at the portal's minute", () => {
    expect(hourlyServiceUnit({ portal: "android-nj", node: "/usr/bin/node", root: "/repo", searchPath: "/usr/bin", log: "/repo/hourly.log", name: "jev-hourly-android-nj" })).toContain("ExecStart=/usr/bin/node /repo/bin/jev.js hourly");
    expect(hourlyTimerUnit({ portal: "android-nj", minute: 20, name: "jev-hourly-android-nj" })).toContain("OnCalendar=*-*-* *:20:00");
  });
  it("installs a systemd timer under a temporary home", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-systemd-"));
    const calls: string[][] = [];
    const out = installHourlySchedule("android-nj", 20, { platform: "linux", home: dir, run: (args) => { calls.push(args); return { status: 0 }; } });
    const files = hourlyUnitFiles("android-nj", dir);
    expect(out.minute).toBe(20);
    expect(readFileSync(files.timer, "utf8")).toContain("*:20:00");
    expect(calls.some((c) => c.includes("enable"))).toBe(true);
  });
});
