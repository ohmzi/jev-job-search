import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOURLY } from "../src/config.js";
import { jobId, type Job } from "../src/jobs/normalize.js";
import { entryFor, loadQueue, saveQueue } from "../src/jobs/queue.js";
import { loadRows } from "../src/log/csv.js";
import type { Profile } from "../src/profile/schema.js";
import { countToday, localDay } from "../src/run/daily.js";
import { applyEasyApply } from "../src/run/easyApply.js";
import { markLoginRequired, readLoginRequired } from "../src/run/linkedinSession.js";
import { Policy } from "../src/run/policy.js";
import { loadSharedApplied, recordSharedApplied } from "../src/run/shared.js";
import type { ToolCall } from "../src/sources/listingLink.js";
import { FieldsDump, isApplicationForm } from "../src/forms/fields.js";
import { pickNext } from "../src/browser/report.js";

const dump = (over: Record<string, unknown> = {}) =>
  FieldsDump.parse({ url: "https://www.linkedin.com/jobs/view/4483157190/", fields: [], ...over });

describe("a LinkedIn Easy Apply dialog", () => {
  it("is an application even when LinkedIn already holds the name", () => {
    const d = dump({
      easyApply: true,
      fields: [
        { id: "f0", selector: "#email", kind: "email", label: "Email address", required: true },
        { id: "f1", selector: "#phone", kind: "tel", label: "Mobile phone number", required: false },
      ],
    });
    expect(isApplicationForm(d)).toBe(true);
  });

  it("is not an application when nothing marks it as one", () => {
    const d = dump({
      fields: [
        { id: "f0", selector: "#email", kind: "email", label: "Email or phone", required: true },
      ],
    });
    expect(isApplicationForm(d)).toBe(false);
  });
});

describe("the last forward step of the dialog", () => {
  it("takes Review as the way on inside the dialog", () => {
    expect(pickNext(["#next  /* Review */"], true)).toEqual({ selector: "#next", text: "Review" });
  });

  it("does not take Review as a way on for an ordinary form", () => {
    expect(pickNext(["#r  /* Review your answers */"])).toBeNull();
  });
});

const NOW = new Date("2026-10-24T12:00:00");
const profile = {
  search: { portal: "android-tx", terms: ["android developer"], locations: [{ query: "Toronto, ON, Canada", distance: 40, accept: ["Toronto"] }] },
} as unknown as Profile;
const policy = Policy.parse({});

const files = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-easy-"));
  return { queue: path.join(dir, "queue.json"), rows: path.join(dir, "all.csv") };
};

const searchReply = (ids: string[]) => JSON.stringify({ url: "https://www.linkedin.com/jobs/search/", sections: {}, job_ids: ids });
const readReply = (id: string, type: string) => JSON.stringify({ url: `https://www.linkedin.com/jobs/view/${id}`, apply: { type } });
const postingReply = (posting: string) => JSON.stringify({ sections: { job_posting: posting } });
const detailsReply = (age: string, company = "Acme Corp", title = "Android Engineer") => postingReply(`${company}\n${title}\nToronto, ON · ${age} · 12 applicants`);
const applyReply = (status = "applied") => JSON.stringify({ status, message: status === "applied" ? "Application sent" : status, learned: [], unanswered: [] });

const queuedEntry = (url: string, over: Partial<ReturnType<typeof entryFor>> = {}) => {
  const job: Job = {
    id: jobId(url), source: "jobspy linkedin", company: "Acme Corp", title: "Android Engineer", url, ats: "linkedin",
    locations: ["Toronto, ON"], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null,
  };
  return { ...entryFor(job, null, null), ...over };
};

/** A fake MCP that answers the named tools, records the calls and the sleep that came before each, and can be closed. */
function harness(routes: Record<string, (args: Record<string, unknown>) => string>) {
  const calls: { tool: string; args: Record<string, unknown>; sleptBefore: number }[] = [];
  const slept: number[] = [];
  let total = 0;
  let closed = 0;
  const sleep = async (ms: number) => {
    slept.push(ms);
    total += ms;
  };
  const call: ToolCall = async (_board, tool, args) => {
    calls.push({ tool, args, sleptBefore: total });
    const route = routes[tool];
    if (!route) throw new Error(`unexpected tool ${tool}`);
    return route(args);
  };
  return { calls, slept, sleep, call, close: () => { closed++; }, closed: () => closed };
}

describe("the hourly Easy Apply step", () => {
  let shared: string;
  let sessionOptions: { authRoot: string; backupRoot: string; dataDir: string };
  const before = process.env.JEV_SHARED_DIR;
  beforeEach(() => {
    shared = mkdtempSync(path.join(os.tmpdir(), "jev-easy-shared-"));
    process.env.JEV_SHARED_DIR = shared;
    // A complete saved session in a temp root, so no test touches the real one.
    const base = mkdtempSync(path.join(os.tmpdir(), "jev-easy-session-"));
    const authRoot = path.join(base, "auth");
    mkdirSync(path.join(authRoot, "profile"), { recursive: true });
    writeFileSync(path.join(authRoot, "profile", "Preferences"), "{}");
    writeFileSync(path.join(authRoot, "cookies.json"), JSON.stringify([{ name: "li_at", value: "made-up" }]));
    writeFileSync(path.join(authRoot, "source-state.json"), JSON.stringify({ version: 1 }));
    sessionOptions = { authRoot, backupRoot: path.join(base, "backup"), dataDir: path.join(base, "data") };
  });
  afterEach(() => {
    if (before === undefined) delete process.env.JEV_SHARED_DIR;
    else process.env.JEV_SHARED_DIR = before;
  });

  it("sends the easy apply posting it finds and records it on the board, the sheet and the shared list", async () => {
    const f = files();
    const ids = ["111111", "222222", "333333"];
    const h = harness({
      search_jobs: () => searchReply(ids),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, job_id === ids[0] ? "easy_apply" : "external"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(summary).toMatchObject({ found: 3, scanned: 3, tooOld: 0, left: 0, stopped: null });
    expect(summary.applied).toEqual([{ company: "Acme Corp", title: "Android Engineer", url: "https://www.linkedin.com/jobs/view/111111" }]);
    expect(h.calls[0]?.args).toMatchObject({ keywords: "android developer", location: "Toronto, ON, Canada", easy_apply: true, date_posted: "past_24_hours", max_pages: 2 });
    expect(h.calls.filter((c) => c.tool === "apply_to_job")).toHaveLength(1);
    expect(h.closed()).toBe(1);

    const queue = loadQueue(f.queue).entries;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      status: "applied",
      statusReason: null,
      applyable: false,
      job: { source: "linkedin easy apply (mcp)", url: "https://www.linkedin.com/jobs/view/111111", ats: "linkedin" },
    });
    expect(queue[0]?.appliedAt).not.toBeNull();
    // The stamped time is the real clock, not the injected pacing time.
    expect(queue[0]?.appliedAt).not.toBe(NOW.toISOString());
    const rows = loadRows(f.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "App. Status": "Applied", Source: "linkedin easy apply (mcp)", Company: "Acme Corp", "Role / Title": "Android Engineer" });
    expect(loadSharedApplied().some((e) => e.company === "Acme Corp" && e.title === "Android Engineer" && e.portal === "android-tx")).toBe(true);
  });

  it("does not read or apply to a posting the board already records as applied", async () => {
    const f = files();
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [queuedEntry("https://www.linkedin.com/jobs/view/111111", { status: "applied" })] }, f.queue);

    const h = harness({ search_jobs: () => searchReply(["111111"]) });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(summary.found).toBe(1);
    expect(summary.scanned).toBe(0);
    expect(h.calls.map((c) => c.tool)).toEqual(["search_jobs"]);
  });

  it("makes no application and writes nothing in a rehearsal, but reads and age-checks a few postings", async () => {
    const f = files();
    const h = harness({
      search_jobs: () => searchReply(["111111", "222222"]),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "easy_apply"),
      get_job_details: ({ job_id }) => detailsReply(job_id === "111111" ? "2 days ago" : "5 hours ago"),
    });
    const logs: string[] = [];
    const summary = await applyEasyApply(profile, { session: sessionOptions, dry: true, policy, log: (line) => logs.push(line), call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(h.calls.some((c) => c.tool === "apply_to_job")).toBe(false);
    expect(summary.applied).toEqual([]);
    expect(summary.scanned).toBe(2);
    expect(summary.tooOld).toBe(1);
    expect(logs.join("\n")).toMatch(/would apply: Acme Corp - Android Engineer/);
    expect(existsSync(f.queue)).toBe(false);
    expect(existsSync(f.rows)).toBe(false);
  });

  it("holds the count cap and leaves the submission gap", async () => {
    const ids = ["111111", "222222", "333333"];
    const h = harness({
      search_jobs: () => searchReply(ids),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "easy_apply"),
      get_job_details: ({ job_id }) => detailsReply("5 hours ago", `${job_id === "111111" ? "Alpha" : job_id === "222222" ? "Beta" : "Gamma"} Corp`),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, count: 2, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.applied).toHaveLength(2);
    const applies = h.calls.filter((c) => c.tool === "apply_to_job");
    expect(applies).toHaveLength(2);
    // The third posting is never read because the cap is reached.
    expect(h.calls.filter((c) => c.tool === "get_job_apply_url")).toHaveLength(2);
    // The pacing clock only moves with sleeps, so the sleep between the two submissions is the gap.
    expect((applies[1]?.sleptBefore ?? 0) - (applies[0]?.sleptBefore ?? 0)).toBeGreaterThanOrEqual(HOURLY.easyApply.gapMs);
  });

  it("stops the whole step at a board notice in a read reply", async () => {
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => JSON.stringify({ url: "https://www.linkedin.com/jobs/view/111111", section_errors: { apply: { error_type: "rate_limit", error_message: "We detected unusual activity on your account" } } }),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.stopped).toMatch(/rate_limit|unusual activity/);
    expect(summary.applied).toEqual([]);
    expect(h.calls.some((c) => c.tool === "apply_to_job")).toBe(false);
  });

  it("does not mistake a posting's own words for a board notice", async () => {
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => postingReply(
        "Acme Corp\nAndroid Engineer\nToronto, ON · 5 hours ago · 12 applicants\n\nAbout the job\nYou will enjoy hard challenges and rate limiting work; verify your experience and pass the security check for our office.",
      ),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.stopped).toBeNull();
    expect(summary.applied).toHaveLength(1);
  });

  it("skips a posting older than twelve hours and one whose age cannot be read", async () => {
    const h = harness({
      search_jobs: () => searchReply(["111111", "222222", "333333"]),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "easy_apply"),
      get_job_details: ({ job_id }) => {
        if (job_id === "111111") return detailsReply("2 days ago");
        if (job_id === "222222") return postingReply("Acme Corp\nAndroid Engineer\nToronto, ON · 12 applicants");
        return detailsReply("5 hours ago");
      },
      apply_to_job: () => applyReply(),
    });
    const logs: string[] = [];
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, log: (line) => logs.push(line), call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.tooOld).toBe(2);
    expect(summary.applied).toHaveLength(1);
    expect(summary.applied[0]?.url).toBe("https://www.linkedin.com/jobs/view/333333");
    expect(h.calls.filter((c) => c.tool === "apply_to_job")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/skipped: posted 2 days ago/);
    expect(logs.join("\n")).toMatch(/posted date could not be read/);
  });

  it("reads the live layout and an age that sits on a line of its own", async () => {
    const f = files();
    const captured = "Baxter International Inc.\n\nPrincipal Software Engineer – Android,\n\nSkaneateles Falls, NY · 5 hours ago · 12 applicants\n\nAbout the job\nBuild software.";
    const h = harness({
      search_jobs: () => searchReply(["111111", "222222"]),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "easy_apply"),
      get_job_details: ({ job_id }) => postingReply(job_id === "111111" ? captured : "Acme Corp\nAndroid Engineer\nToronto, ON\n5 hours ago\n12 applicants"),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(summary.tooOld).toBe(0);
    expect(summary.applied).toHaveLength(2);
    const queue = loadQueue(f.queue).entries;
    const baxter = queue.find((e) => e.job.company === "Baxter International Inc.");
    expect(baxter?.job.title).toBe("Principal Software Engineer – Android,");
    expect(baxter?.job.locations).toEqual(["Skaneateles Falls, NY"]);
    expect(queue.find((e) => e.job.company === "Acme Corp")?.job.locations).toEqual(["Toronto, ON"]);
  });

  it("updates the source of a queued entry it reuses", async () => {
    const f = files();
    const url = "https://www.linkedin.com/jobs/view/111111";
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [queuedEntry(url)] }, f.queue);
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(),
    });
    await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    const queue = loadQueue(f.queue).entries;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ status: "applied", job: { source: "linkedin easy apply (mcp)" } });
  });

  it("leaves an ambiguous send unconfirmed and never sends it again", async () => {
    const f = files();
    const first = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => { throw new Error("the linkedin apply tool did not answer in 240s"); },
    });
    const one = await applyEasyApply(profile, { session: sessionOptions, policy, call: first.call, close: first.close, now: NOW, sleep: first.sleep, files: f });
    expect(one.left).toBe(1);
    expect(one.applied).toEqual([]);
    expect(loadQueue(f.queue).entries[0]).toMatchObject({ status: "submission_unknown", appliedAt: null });
    expect(loadRows(f.rows)[0]?.["App. Status"]).toMatch(/^Unconfirmed/);

    // The next hour sees the unconfirmed record and does not touch the posting at all.
    const second = harness({ search_jobs: () => searchReply(["111111"]) });
    const two = await applyEasyApply(profile, { session: sessionOptions, policy, call: second.call, close: second.close, now: NOW, sleep: second.sleep, files: f });
    expect(two.scanned).toBe(0);
    expect(second.calls.map((c) => c.tool)).toEqual(["search_jobs"]);
  });

  it("records an already applied posting without counting it against the cap or stamping a time", async () => {
    const f = files();
    const replies: Record<string, string> = { "111111": "already_applied", "222222": "applied" };
    const h = harness({
      search_jobs: () => searchReply(["111111", "222222"]),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "easy_apply"),
      get_job_details: ({ job_id }) => detailsReply("5 hours ago", job_id === "111111" ? "First Corp" : "Second Corp"),
      apply_to_job: ({ job_id }) => applyReply(replies[job_id as string]),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, count: 1, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    // The already-applied posting does not use the run's one slot.
    expect(h.calls.filter((c) => c.tool === "apply_to_job")).toHaveLength(2);
    expect(summary.applied).toHaveLength(1);
    const queue = loadQueue(f.queue).entries;
    expect(queue).toHaveLength(2);
    expect(queue.find((e) => e.job.url.endsWith("111111"))).toMatchObject({ status: "applied", appliedAt: null });
    expect(queue.find((e) => e.job.url.endsWith("222222"))?.appliedAt).not.toBeNull();
  });

  it("stops before sending when the record cannot be written", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-easy-bad-"));
    const f = { queue: path.join(dir, "queue.json"), rows: mkdtempSync(path.join(os.tmpdir(), "jev-easy-rows-")) };
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(h.calls.some((c) => c.tool === "apply_to_job")).toBe(false);
    expect(summary.applied).toEqual([]);
    expect(summary.reason).toMatch(/could not be written/);
  });

  it("does not mistake a notice-like string in the search sections for a board notice", async () => {
    const h = harness({
      search_jobs: () => JSON.stringify({ url: "https://www.linkedin.com/jobs/search/", sections: { search_results: "captcha unusual activity security check rate limited verify you are human" }, job_ids: ["111111"] }),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.stopped).toBeNull();
    expect(summary.applied).toHaveLength(1);
  });

  it.each([
    ["blocked", "needs_review", "Needs you"],
    ["external", "needs_review", "Needs you"],
    ["closed", "skipped", "Skipped: the posting is closed"],
  ] as const)("restores a %s posting the fork proved it did not send", async (status, queueStatus, csvStatus) => {
    const f = files();
    const first = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(status),
    });
    const one = await applyEasyApply(profile, { session: sessionOptions, policy, call: first.call, close: first.close, now: NOW, sleep: first.sleep, files: f });

    expect(one.applied).toEqual([]);
    const queue = loadQueue(f.queue).entries;
    expect(queue[0]).toMatchObject({ status: queueStatus, appliedAt: null });
    expect(queue[0]?.statusReason).toBe(status === "closed" ? "the posting is closed" : status);
    expect(loadRows(f.rows)[0]?.["App. Status"]).toBe(csvStatus);
    // Nothing was sent, so the day has no unconfirmed send hiding in its count.
    expect(countToday(queue, localDay(NOW)).unconfirmed).toBe(0);

    // The next hour still considers the posting instead of treating it as already sent.
    const second = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(),
    });
    const two = await applyEasyApply(profile, { session: sessionOptions, policy, call: second.call, close: second.close, now: NOW, sleep: second.sleep, files: f });
    expect(two.scanned).toBe(1);
    expect(second.calls.some((c) => c.tool === "get_job_apply_url")).toBe(true);
  });

  it("writes the shared list even when the local record fails after a confirmed send", async () => {
    const f = files();
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => {
        // Make the queue unreadable between the pre-send record and the promotion.
        rmSync(f.queue, { force: true });
        mkdirSync(f.queue);
        return applyReply();
      },
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(summary.applied).toHaveLength(1);
    expect(summary.reason).toMatch(/could not be recorded/);
    expect(loadSharedApplied().some((e) => e.company === "Acme Corp" && e.title === "Android Engineer")).toBe(true);
  });

  it("says so when no result takes Easy Apply, without writing anything", async () => {
    const f = files();
    const h = harness({
      search_jobs: () => searchReply(["111111", "222222", "333333"]),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "external"),
    });
    const logs: string[] = [];
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, log: (line) => logs.push(line), call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(summary.notEasyApply).toBe(3);
    expect(summary.applied).toEqual([]);
    expect(summary.reason).toBe("no posting in the results was an Easy Apply posting");
    expect(h.calls.some((c) => c.tool === "apply_to_job")).toBe(false);
    expect(logs.join("\n")).toMatch(/111111 skipped: not easy apply \(external\)/);
    expect(existsSync(f.queue)).toBe(false);
    expect(existsSync(f.rows)).toBe(false);
  });

  it("skips a posting another portal has already sent", async () => {
    const url = "https://www.linkedin.com/jobs/view/111111";
    recordSharedApplied([{ id: jobId(url), company: "Acme Corp", title: "Android Engineer", url }], "other-portal");
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
    });
    const logs: string[] = [];
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, log: (line) => logs.push(line), call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.applied).toEqual([]);
    expect(h.calls.some((c) => c.tool === "apply_to_job")).toBe(false);
    expect(logs.join("\n")).toMatch(/another portal already applied/);
  });

  it("stops before calling the MCP when there is no usable session", async () => {
    const f = files();
    const base = mkdtempSync(path.join(os.tmpdir(), "jev-easy-nosession-"));
    const dataDir = path.join(base, "data");
    const h = harness({});
    const summary = await applyEasyApply(profile, {
      session: { authRoot: path.join(base, "auth"), backupRoot: path.join(base, "backup"), dataDir },
      policy,
      call: h.call,
      close: h.close,
      now: NOW,
      sleep: h.sleep,
      files: f,
    });

    expect(h.calls).toEqual([]);
    expect(h.closed()).toBe(0);
    expect(summary.reason).toBe("LinkedIn login required: cookies.json is missing");
    expect(readLoginRequired(dataDir)).toMatchObject({ reason: "cookies.json is missing" });
  });

  it("marks login required and stops at a reply that says the fork needs a sign-in", async () => {
    const h = harness({
      search_jobs: () => JSON.stringify({ error_type: "authentication_started", error_message: "A LinkedIn login window is open and login is still in progress." }),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.reason).toBe("LinkedIn login required: login window");
    expect(h.calls.map((c) => c.tool)).toEqual(["search_jobs"]);
    expect(readLoginRequired(sessionOptions.dataDir)).toMatchObject({ reason: "login window" });
  });

  it("clears a stale login flag when a run reaches the board", async () => {
    markLoginRequired("cookies.json is missing", sessionOptions.dataDir);
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { session: sessionOptions, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.applied).toHaveLength(1);
    expect(readLoginRequired(sessionOptions.dataDir)).toBeNull();
  });
});
