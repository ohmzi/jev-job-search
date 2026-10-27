import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clean, logEvent, readEvents, setEventContext } from "../src/log/events.js";
import { analyzeEvents, printAnalysis } from "../src/log/analyze.js";
import { mutateQueue, saveQueue, type QueueEntry } from "../src/jobs/queue.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jev-events-"));
  process.env.JEV_EVENTS_DIR = dir;
  setEventContext({ portal: "fullstack-nj", cmd: "hourly" });
});
afterEach(() => {
  delete process.env.JEV_EVENTS_DIR;
});

describe("the event log", () => {
  it("keeps no secret, no query string and no long text", () => {
    const c = clean({ password: "hunter22", token: "x", url: "https://boards.greenhouse.io/acme/jobs/1?token=abc", note: "a".repeat(900), nested: { code: "123456", ok: 1 } }) as Record<string, unknown>;
    expect(c.password).toBeUndefined();
    expect(c.token).toBeUndefined();
    expect(c.url).toBe("https://boards.greenhouse.io/acme/jobs/1");
    expect(String(c.note).length).toBeLessThan(520);
    expect(c.nested).toEqual({ ok: 1 });
  });

  it("writes one line per event under the portal and reads them back by day and kind", () => {
    const now = new Date("2026-10-27T10:00:00");
    logEvent("board.read", { ats: "greenhouse", slug: "stripe", company: "Stripe", ok: true, open: 40, kept: 2 }, now);
    logEvent("say", { line: "hello" }, now);
    const files = readdirSync(dir);
    expect(files).toEqual(["2026-10-27.jsonl"]);
    const line = JSON.parse(readFileSync(path.join(dir, files[0] as string), "utf8").split("\n")[0] as string);
    expect(line).toMatchObject({ portal: "fullstack-nj", cmd: "hourly", kind: "board.read", kept: 2 });
    expect(readEvents(1, { now, kinds: ["board"] })).toHaveLength(1);
    expect(readEvents(1, { now })).toHaveLength(2);
  });

  it("records every job a queue change adds and every status it moves", () => {
    const queueFile = path.join(dir, "queue.json");
    const entry = { job: { id: "", source: "greenhouse:acme", company: "Acme", title: "Senior Full Stack Engineer", url: "https://boards.greenhouse.io/acme/jobs/1", ats: "greenhouse", locations: ["Jersey City, NJ"], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null, easyApply: false }, fit: null, preFilterReason: null, applyable: true, holdUntil: null, status: "queued", statusReason: null, attempts: 0, discoveredAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appliedAt: null, notes: null, waitingFor: null, answers: [] } as unknown as QueueEntry;
    saveQueue({ version: 1, generatedAt: new Date().toISOString(), entries: [] }, queueFile);
    mutateQueue((q) => { q.entries.push(entry); }, queueFile);
    mutateQueue((q) => { const e = q.entries[0] as QueueEntry; e.status = "needs_review"; e.statusReason = "the form asks for a signature"; }, queueFile);
    const events = readEvents(1, { kinds: ["job"] });
    expect(events.map((e) => e.kind)).toEqual(["job.added", "job.status"]);
    expect(events[1]).toMatchObject({ from: "queued", to: "needs_review", reason: "the form asks for a signature", company: "Acme" });
  });
});

describe("reading the log back", () => {
  const ev = (kind: string, extra: Record<string, unknown> = {}, portal = "fullstack-nj", run = "r1", at = "2026-10-27T10:00:00.000Z") => ({ at, portal, run, cmd: "hourly", kind, ...extra });

  it("counts sources, boards, sends and what stood in the way", () => {
    const a = analyzeEvents([
      ev("cmd.start"),
      ev("jobspy.query", { ok: true, rows: 30, kept: 4 }),
      ev("freehire.call", { ok: true, returned: 50, kept: 3 }),
      ev("board.read", { ats: "greenhouse", slug: "stripe", company: "Stripe", ok: true, open: 40, kept: 2 }),
      ev("board.read", { ats: "ashby", slug: "gone", company: "Gone", ok: false }),
      ev("board.read", { ats: "ashby", slug: "gone", company: "Gone", ok: false }),
      ev("job.added", { source: "greenhouse:stripe" }),
      ev("job.status", { from: "queued", to: "submission_unknown" }),
      ev("job.status", { from: "submission_unknown", to: "applied" }),
      ev("job.status", { from: "queued", to: "needs_review", reason: "the contact step shows no phone number to set" }),
      ev("apply.pick", { picked: [{ id: "a" }], notPicked: { "tried twice": 2 } }),
      ev("lock.take", { waitedMs: 120_000 }),
      ev("form.outcome", { action: "needs_review", reason: "a signature", failed: [{ label: "Phone" }], missingRequired: ["Signature"] }),
      ev("cmd.exit", { code: 0 }, "fullstack-nj", "r1", "2026-10-27T10:06:00.000Z"),
    ]);
    const p = a.portals["fullstack-nj"];
    expect(p?.jobspy).toEqual({ queries: 1, failed: 0, rows: 30, kept: 4 });
    expect(p?.boards).toEqual({ reads: 3, failed: 2, open: 40, kept: 2 });
    expect(p?.applied).toBe(1);
    expect(p?.unconfirmed).toBe(1);
    expect(p?.notPicked).toEqual({ "tried twice": 2 });
    expect(p?.lockWaits).toBe(1);
    expect(p?.minutes.hourly).toBe(6);
    expect(a.formFailedFields).toEqual({ Phone: 1, "required: Signature": 1 });
    const text = printAnalysis(a).join("\n");
    expect(text).toContain("Boards that failed every read");
    expect(text).toContain("Gone (ashby)");
    expect(text).toContain("the contact step shows no phone number");
  });
});
