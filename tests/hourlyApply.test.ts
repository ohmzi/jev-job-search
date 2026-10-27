import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atsFromUrl, type Job } from "../src/jobs/normalize.js";
import { appliedKey } from "../src/jobs/keys.js";
import type { QueueEntry } from "../src/jobs/queue.js";
import { Policy, policyRefuses } from "../src/run/policy.js";
import { mayApplyToday, pickFresh, settleAfterAttempt } from "../src/run/hourlyApply.js";
import { pickJobs } from "../src/run/pipeline.js";
import { acquireGlobalRun, recordSharedApplied, sharedAppliedKeys } from "../src/run/shared.js";

const NOW = new Date("2026-10-22T12:00:00");

const job = (over: Partial<Job> = {}): Job => ({
  id: "job-1",
  source: "jobspy indeed",
  company: "Acme",
  title: "Android Engineer",
  url: "https://boards.greenhouse.io/acme/jobs/123",
  ats: "greenhouse",
  locations: ["Jersey City, NJ"],
  postedAt: "2026-10-22",
  terms: [],
  sponsorship: "unknown",
  degrees: [],
  category: null,
  easyApply: false,
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

const old = new Date(NOW.getTime() - 30 * 3_600_000).toISOString();
const freshPolicy = () => Policy.parse({ minScore: 0.9, admitRecent: true });

describe("the hourly apply pass", () => {
  let shared: string;
  const before = process.env.JEV_SHARED_DIR;
  beforeEach(() => {
    shared = mkdtempSync(path.join(os.tmpdir(), "jev-shared-"));
    process.env.JEV_SHARED_DIR = shared;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.JEV_SHARED_DIR;
    else process.env.JEV_SHARED_DIR = before;
  });

  it("admits a fresh job with no score and refuses an old unscored one", () => {
    const policy = freshPolicy();
    expect(policyRefuses(entry(), policy, NOW)).toBeNull();
    expect(policyRefuses(entry({ discoveredAt: old }), policy, NOW)).toMatch(/under 0.9/);
  });

  it("tries a fresh fillable job first, then a board-only one, but not a tried or already-sent job", () => {
    const sent = entry({ job: { ...job(), id: "sent", title: "Sent Engineer" } as QueueEntry["job"] });
    recordSharedApplied([sent.job], "android-tx", NOW.toISOString());
    const picked = pickFresh(
      [
        entry({ job: { ...job(), id: "held", company: "Beta" } as QueueEntry["job"], applyable: false }),
        entry({ job: { ...job(), id: "fresh" } as QueueEntry["job"] }),
        entry({ job: { ...job(), id: "tried", company: "Gamma" } as QueueEntry["job"], attempts: 2 }),
        sent,
      ],
      freshPolicy(),
      NOW,
      2,
      () => null,
    );
    expect(picked.map((e) => e.job.id)).toEqual(["fresh", "held"]);
  });

  it("takes one role per employer in one pass", () => {
    const picked = pickFresh(
      [
        entry({ job: { ...job(), id: "a" } as QueueEntry["job"] }),
        entry({ job: { ...job(), id: "b", title: "Mobile Engineer" } as QueueEntry["job"] }),
      ],
      freshPolicy(),
      NOW,
      2,
      () => null,
    );
    expect(picked).toHaveLength(1);
  });

  it("gives a failed job one more try, then leaves it for the person", () => {
    const retry = entry({ status: "failed", attempts: 1 });
    expect(settleAfterAttempt(retry, NOW)).toBe(true);
    expect(retry.status).toBe("queued");
    const done = entry({ status: "failed", attempts: 2 });
    expect(settleAfterAttempt(done, NOW)).toBe(true);
    expect(done.status).toBe("needs_review");
    expect(done.statusReason).toMatch(/two|2 attempts/);
  });

  it("never retries a sent, held or unconfirmed job", () => {
    for (const status of ["applied", "submission_unknown", "awaiting_user_action", "awaiting_email_verification", "login_required", "blocked", "skipped"] as const) {
      const e = entry({ status, attempts: 2 });
      expect(settleAfterAttempt(e, NOW)).toBe(false);
      expect(e.status).toBe(status);
    }
  });

  it("lets only one portal hold the browser at a time", () => {
    const release = acquireGlobalRun("android-nj");
    expect(release).not.toBeNull();
    expect(acquireGlobalRun("android-tx")).toBeNull();
    release?.();
    const again = acquireGlobalRun("android-tx");
    expect(again).not.toBeNull();
    again?.();
  });

  it("remembers a sent job across portals", () => {
    recordSharedApplied([{ ...job(), id: "x", company: "Acme", title: "Android Engineer" }], "android-nj", NOW.toISOString());
    expect(sharedAppliedKeys().has(appliedKey({ company: "Acme", title: "Android Engineer" }))).toBe(true);
  });

  it("keeps the day's target, the board limit, the employer limit and a paused board", () => {
    const policy = Policy.parse({ target: 15, minScore: 0.9 });
    const day = (over: Partial<{ sent: number; unconfirmed: number; board: Map<string, number>; employer: Map<string, number>; open: Map<string, number>; last: Map<string, number> }> = {}) => ({
      sent: 0, unconfirmed: 0, board: new Map<string, number>(), employer: new Map<string, number>(), open: new Map<string, number>(), last: new Map<string, number>(), ...over,
    });
    expect(mayApplyToday(entry(), policy, day(), {}, NOW)).toBe(true);
    expect(mayApplyToday(entry(), policy, day({ sent: 15 }), {}, NOW)).toBe(false);
    expect(mayApplyToday(entry(), policy, day({ board: new Map([["greenhouse", 8]]) }), {}, NOW)).toBe(false);
    expect(mayApplyToday(entry(), policy, day({ employer: new Map([["acme", 1]]) }), {}, NOW)).toBe(false);
    expect(mayApplyToday(entry(), policy, day(), { greenhouse: { until: new Date(NOW.getTime() + 3_600_000).toISOString(), why: "a human check" } }, NOW)).toBe(false);
  });

  it("does not pick a job another portal already sent, even when asked for by hand", () => {
    const e = entry();
    const shared = new Set([appliedKey(e.job)]);
    expect(pickJobs([e], [], { count: 1, dry: true, shared }, () => null).picked).toHaveLength(0);
    const named = pickJobs([e], [e.job.id], { count: 1, dry: false, shared }, () => null);
    expect(named.picked).toHaveLength(0);
    expect(named.refused[0]?.why).toMatch(/another portal/);
  });

  it("recognizes Workable and JazzHR links as fillable boards", () => {
    expect(atsFromUrl("https://apply.workable.com/acme/j/ABC123")).toBe("workable");
    expect(atsFromUrl("https://acme.applytojob.com/apply/abc")).toBe("jazzhr");
  });
});
