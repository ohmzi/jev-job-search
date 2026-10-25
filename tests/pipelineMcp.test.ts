import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP, PATHS, RUN } from "../src/config.js";
import { loadLearned } from "../src/answers/learned.js";
import { ensureBrowser } from "../src/browser/cdp.js";
import { jobId } from "../src/jobs/normalize.js";
import { loadQueue, saveQueue, type QueueEntry } from "../src/jobs/queue.js";
import { loadReport } from "../src/browser/report.js";
import { pipeline, takeJobs, type RunOptions } from "../src/run/pipeline.js";
import { NotAvailable } from "../src/sources/listingLink.js";
import { McpApplyError } from "../src/sources/linkedinApply.js";

// The apply loop builds its client on the way in, and the tests drive no DeepSeek call.
process.env.DEEPSEEK_API_KEY ??= "not-a-key";

const NOW = new Date("2026-10-24T12:00:00");
const URL_ONE = "https://www.linkedin.com/jobs/view/4252026496";
const URL_TWO = "https://www.linkedin.com/jobs/view/4252026497";

/** The caller the apply loop starts, with what the test wants it to answer. */
const fake = vi.hoisted(() => ({
  call: null as null | ((board: string, tool: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<string>),
  applyCalls: 0,
  applyArgs: [] as Record<string, unknown>[],
  applyTimeouts: [] as (number | undefined)[],
  closed: 0,
  learnedFails: false,
}));

vi.mock("../src/answers/learned.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/answers/learned.js")>();
  return {
    ...actual,
    addLearned: (rows: Parameters<typeof actual.addLearned>[0], file?: string) => {
      if (fake.learnedFails) {
        fake.learnedFails = false;
        throw new Error("the answer store is not writable");
      }
      return actual.addLearned(rows, file);
    },
  };
});

// The Chrome path is exercised by the pipeline tests with a fill that cannot open a page.
vi.mock("../src/browser/formRunner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/browser/formRunner.js")>();
  return {
    ...actual,
    fillJob: vi.fn(async () => {
      throw new Error("no Chrome in this test");
    }),
  };
});

vi.mock("../src/sources/listingLink.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sources/listingLink.js")>();
  return {
    ...actual,
    mcpCaller: () => ({
      call: (board: string, tool: string, args: Record<string, unknown>, timeoutMs?: number) => fake.call!(board, tool, args, timeoutMs),
      close: () => {
        fake.closed++;
      },
    }),
  };
});

// The loop opens no page for an Easy Apply job, and the tests open no browser.
vi.mock("../src/browser/cdp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/browser/cdp.js")>();
  return { ...actual, ensureBrowser: vi.fn(async () => undefined) };
});

const paths = PATHS as unknown as Record<string, string>;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jev-pipeline-mcp-"));
  paths.queue = path.join(dir, "queue.json");
  paths.runs = path.join(dir, "runs");
  paths.applications = path.join(dir, "all.csv");
  paths.applied = path.join(dir, "applied.csv");
  paths.manual = path.join(dir, "manual.csv");
  paths.takehome = path.join(dir, "takehome.csv");
  paths.learned = path.join(dir, "learned.json");
  paths.locks = path.join(dir, "locks");
  paths.profile = path.join(dir, "profile.json");
  paths.accounts = path.join(dir, "accounts.json");
  paths.accountsState = path.join(dir, "accounts-state.json");
  writeFileSync(paths.profile as string, readFileSync(PATHS.profileExample, "utf8"));
  fake.call = null;
  fake.applyCalls = 0;
  fake.applyArgs = [];
  fake.applyTimeouts = [];
  fake.closed = 0;
  fake.learnedFails = false;
  vi.mocked(ensureBrowser).mockClear();
});

const entry = (over: Partial<QueueEntry> = {}, url = URL_ONE, company = "Delta"): QueueEntry => ({
  job: {
    id: jobId(url),
    source: "jobspy linkedin",
    company,
    title: "Android Engineer",
    url,
    ats: "linkedin",
    locations: ["Jersey City, NJ"],
    postedAt: "2026-10-24",
    terms: [],
    sponsorship: "unknown",
    degrees: [],
    category: null,
  } as QueueEntry["job"],
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

const base = (over: Partial<RunOptions> = {}): RunOptions => ({ submit: true, dry: false, fresh: false, quiet: true, linksFile: path.join(dir, "links.json"), ...over });

/** The queue as a real run hands it over: taken, so the status is in_progress and a sent job can never be taken twice. */
const taken = (): QueueEntry[] => {
  saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [entry()] }, paths.queue);
  return takeJobs([jobId(URL_ONE)], { count: 1, dry: false });
};

/** The apply tool's reply, in the shape the server documents. */
const reply = (status: string, extra: Record<string, unknown> = {}) => JSON.stringify({ status, message: `the server said ${status}`, learned: [], unanswered: [], ...extra });

/** Answers the read tool the way an Easy Apply posting does, and the apply tool with what the test asks for. */
const service = (apply: () => Promise<string>) => async (_board: string, tool: string, args: Record<string, unknown>): Promise<string> => {
  if (tool === MCP.linkedin.tools.read) return JSON.stringify({ apply: { type: "easy_apply" } });
  fake.applyCalls++;
  fake.applyArgs.push(args);
  return apply();
};

describe("Easy Apply jobs through the LinkedIn MCP", () => {
  it("records submission_unknown before it calls the apply tool", async () => {
    let seenInsideCall: string | undefined;
    fake.call = service(async () => {
      seenInsideCall = loadQueue().entries[0]?.status;
      return reply("applied");
    });

    await pipeline(taken(), base());

    expect(seenInsideCall).toBe("submission_unknown");
    expect(loadQueue().entries[0]?.status).toBe("applied");
  });

  it("a timed out call leaves the job submission_unknown", async () => {
    fake.call = service(async () => {
      throw new McpApplyError("the linkedin apply tool did not answer in 240s");
    });
    const result = await pipeline(taken(), base());
    expect(loadQueue().entries[0]?.status).toBe("submission_unknown");
    // The summary reads the report slot, so the unconfirmed job is surfaced there too.
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked" });

    // A later run takes the job only when it is not unconfirmed, so it never sends it again.
    const secondRun = takeJobs([jobId(URL_ONE)], { count: 1, dry: false });
    expect(secondRun).toHaveLength(0);
    await pipeline(secondRun, base());
    expect(fake.applyCalls).toBe(1);
  });

  it("a rehearsal never calls the apply tool", async () => {
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [entry()] }, paths.queue);
    fake.call = service(async () => reply("applied"));

    const result = await pipeline([entry()], base({ dry: true }));

    expect(fake.applyCalls).toBe(0);
    expect(loadQueue().entries[0]?.status).toBe("queued");
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked", reason: "a rehearsal sends no easy apply application" });
  });

  it("an applied result is recorded and counted", async () => {
    fake.call = service(async () =>
      reply("applied", { learned: [{ question: "Do you have 5+ years of Android experience?", answer: "Yes", options: ["Yes", "No"], required: true }] }),
    );

    const result = await pipeline(taken(), base());

    expect(result.sent).toContain(jobId(URL_ONE));
    expect(loadQueue().entries[0]?.status).toBe("applied");
    // The summary counts from the report slots, so an MCP application must never leave a hole.
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), company: "Delta", title: "Android Engineer", state: "filled" });
    expect(JSON.parse(JSON.stringify(result.reports))[0]).not.toBeNull();
    expect(loadLearned().pending.map((p) => p.question)).toEqual(["Do you have 5+ years of Android experience?"]);
    // The listing lookup's caller and the apply loop's caller are both stopped when their work is done.
    expect(fake.closed).toBe(2);
    // An Easy Apply run opens no page, so Chrome is never started.
    expect(vi.mocked(ensureBrowser)).not.toHaveBeenCalled();
  });

  it("passes the job's own answers to the apply tool", async () => {
    const answered = entry({ answers: [{ question: "Years of Android experience", answer: "5" }] });
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [answered] }, paths.queue);
    fake.call = service(async () => reply("applied"));

    await pipeline(takeJobs([jobId(URL_ONE)], { count: 1, dry: false }), base());

    expect(fake.applyArgs[0]).toEqual({ job_id: jobId(URL_ONE), answers: { "Years of Android experience": "5" } });
  });

  it.each(["external", "unknown"])("a LinkedIn posting with apply type %s stays off the mcp", async (type) => {
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [entry()] }, paths.queue);
    const entries = takeJobs([jobId(URL_ONE)], { count: 1, dry: false });
    fake.call = async (_board, tool) => {
      if (tool === MCP.linkedin.tools.read) return JSON.stringify({ apply: { type } });
      fake.applyCalls++;
      return reply("applied");
    };

    const result = await pipeline(entries, base());

    // The posting goes to the Chrome path, which holds it for the person, never to the fork.
    expect(fake.applyCalls).toBe(0);
    expect(loadQueue().entries[0]?.applyable).toBe(false);
    expect(loadQueue().entries[0]?.status).not.toBe("submission_unknown");
    expect(result.reports[0]).not.toBeUndefined();
    expect(vi.mocked(ensureBrowser)).toHaveBeenCalled();
  });

  it("a fork that cannot start puts the job back in the queue", async () => {
    fake.call = service(async () => {
      throw new NotAvailable("linkedin");
    });

    const result = await pipeline(taken(), base());

    // Nothing was sent, so the job may be taken again instead of waiting to be settled by hand.
    expect(loadQueue().entries[0]).toMatchObject({ status: "queued" });
    expect(loadQueue().entries[0]?.statusReason).toMatch(/LinkedIn MCP fork/);
    expect(result.sent).toEqual([]);
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked", reason: expect.stringMatching(/fork/) });
  });

  it("a store failure on one easy apply job does not stop the next", async () => {
    const a = entry({}, URL_ONE, "Alpha");
    const b = entry({}, URL_TWO, "Beta");
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a, b] }, paths.queue);
    const entries = takeJobs([a.job.id, b.job.id], { count: 2, dry: false });
    fake.learnedFails = true;
    fake.call = service(async () =>
      reply("applied", { learned: [{ question: "Do you have 5+ years of Android experience?", answer: "Yes", options: ["Yes", "No"], required: true }] }),
    );

    let result: Awaited<ReturnType<typeof pipeline>>;
    vi.useFakeTimers();
    try {
      const run = pipeline(entries, base());
      await vi.advanceTimersByTimeAsync(RUN.submitGapMs + 1);
      result = await run;
    } finally {
      vi.useRealTimers();
    }

    // The first addLearned throws, and the second job is still sent and recorded.
    expect(fake.applyCalls).toBe(2);
    expect(loadQueue().entries.map((e) => e.status)).toEqual(["applied", "applied"]);
    expect(result.reports[0]).toMatchObject({ state: "blocked", reason: "the answer store is not writable" });
    expect(result.reports[1]).toMatchObject({ state: "filled" });
  });

  it.each([
    { what: "a run without --submit", opts: { submit: false } },
    { what: "a fill-only run", opts: { submit: false, fillOnly: true } },
  ])("puts an easy apply job back in the queue in $what", async ({ opts }) => {
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [entry()] }, paths.queue);
    const takenEntries = takeJobs([jobId(URL_ONE)], { count: 1, dry: false });
    expect(takenEntries[0]?.status).toBe("in_progress");
    fake.call = service(async () => reply("applied"));

    const result = await pipeline(takenEntries, base(opts));

    expect(fake.applyCalls).toBe(0);
    expect(loadQueue().entries[0]?.status).toBe("queued");
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked", reason: "not sent: an easy apply job is sent only with --submit" });
  });

  it("gives the apply call the long timeout the wizard needs", async () => {
    fake.call = async (_board, tool, _args, timeoutMs) => {
      if (tool === MCP.linkedin.tools.read) return JSON.stringify({ apply: { type: "easy_apply" } });
      fake.applyCalls++;
      fake.applyTimeouts.push(timeoutMs);
      return reply("applied");
    };

    await pipeline(taken(), base());

    expect(MCP.applyCallMs).toBe(240_000);
    expect(fake.applyTimeouts).toEqual([MCP.applyCallMs]);
  });

  it("spaces two easy apply submissions at one employer", async () => {
    const a = entry({}, URL_ONE, "Spacing Co");
    const b = entry({}, URL_TWO, "Spacing Co");
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [a, b] }, paths.queue);
    const entries = takeJobs([a.job.id, b.job.id], { count: 2, dry: false });
    expect(entries).toHaveLength(2);
    fake.call = service(async () => reply("applied"));

    vi.useFakeTimers();
    try {
      const run = pipeline(entries, base());
      // The first send starts at once; the second waits out the employer window.
      await vi.advanceTimersByTimeAsync(RUN.employerGapMs - 1);
      expect(fake.applyCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.applyCalls).toBe(2);
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a blocked result is needs_review and writes the report", async () => {
    fake.call = service(async () => reply("blocked", { unanswered: [{ label: "Expected salary (USD)", kind: "text", options: [], required: true }] }));

    const result = await pipeline(taken(), base());

    expect(loadQueue().entries[0]?.status).toBe("needs_review");
    expect(loadReport(jobId(URL_ONE)).reviews.map((r) => r.label)).toEqual(["Expected salary (USD)"]);
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked", reason: "the server said blocked" });
  });

  it("a closed posting is skipped with the reason", async () => {
    fake.call = service(async () => reply("closed"));

    const result = await pipeline(taken(), base());

    expect(loadQueue().entries[0]).toMatchObject({ status: "skipped", statusReason: "the posting is closed" });
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked", reason: "the posting is closed" });
  });

  it("a wizard that did not open is needs_review, not unconfirmed", async () => {
    fake.call = service(async () => reply("wizard_not_opened"));

    const result = await pipeline(taken(), base());

    expect(loadQueue().entries[0]).toMatchObject({ status: "needs_review", statusReason: "the server said wizard_not_opened", appliedAt: null });
    expect(loadQueue().entries[0]?.status).not.toBe("submission_unknown");
    expect(result.sent).toEqual([]);
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked", reason: "the server said wizard_not_opened" });
  });

  it("a wizard that opened but was not filled is needs_review", async () => {
    fake.call = service(async () => reply("wizard_open"));

    const result = await pipeline(taken(), base());

    expect(loadQueue().entries[0]).toMatchObject({ status: "needs_review", statusReason: "the wizard opened but was not filled", appliedAt: null });
    expect(result.sent).toEqual([]);
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked", reason: "the wizard opened but was not filled" });
  });

  it("an unknown outcome leaves the job unconfirmed", async () => {
    fake.call = service(async () => reply("outcome_unknown"));

    const result = await pipeline(taken(), base());

    expect(loadQueue().entries[0]?.status).toBe("submission_unknown");
    expect(result.reports[0]).toMatchObject({ jobId: jobId(URL_ONE), state: "blocked" });
  });
});
