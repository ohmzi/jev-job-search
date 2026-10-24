import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOURLY } from "../src/config.js";
import { jobId, type Job } from "../src/jobs/normalize.js";
import { entryFor, loadQueue, saveQueue } from "../src/jobs/queue.js";
import { loadRows } from "../src/log/csv.js";
import type { Profile } from "../src/profile/schema.js";
import { applyEasyApply } from "../src/run/easyApply.js";
import { Policy } from "../src/run/policy.js";
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
  search: { terms: ["android developer"], locations: [{ query: "Toronto, ON, Canada", distance: 40, accept: ["Toronto"] }] },
} as unknown as Profile;
const policy = Policy.parse({});

const files = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-easy-"));
  return { queue: path.join(dir, "queue.json"), rows: path.join(dir, "all.csv") };
};

const searchReply = (ids: string[]) => JSON.stringify({ url: "https://www.linkedin.com/jobs/search/", sections: {}, job_ids: ids });
const readReply = (id: string, type: string) => JSON.stringify({ url: `https://www.linkedin.com/jobs/view/${id}`, apply: { type } });
const detailsReply = (age: string) => JSON.stringify({ sections: { job_posting: `Acme Corp\nAndroid Engineer\nToronto, ON · ${age} · 12 applicants` } });
const applyReply = (status = "applied") => JSON.stringify({ status, message: status === "applied" ? "Application sent" : status, learned: [], unanswered: [] });

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
  it("sends the easy apply posting it finds and records it on the board and the sheet", async () => {
    const f = files();
    const ids = ["111111", "222222", "333333"];
    const h = harness({
      search_jobs: () => searchReply(ids),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, job_id === ids[0] ? "easy_apply" : "external"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

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
    const rows = loadRows(f.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ "App. Status": "Applied", Source: "linkedin easy apply (mcp)", Company: "Acme Corp", "Role / Title": "Android Engineer" });
  });

  it("does not read or apply to a posting the board already records as applied", async () => {
    const f = files();
    const url = "https://www.linkedin.com/jobs/view/111111";
    const job: Job = {
      id: jobId(url), source: "jobspy linkedin", company: "Acme Corp", title: "Android Engineer", url, ats: "linkedin",
      locations: ["Toronto, ON"], postedAt: null, terms: [], sponsorship: "unknown", degrees: [], category: null,
    };
    const entry = entryFor(job, null, null);
    entry.status = "applied";
    saveQueue({ version: 1, generatedAt: NOW.toISOString(), entries: [entry] }, f.queue);

    const h = harness({ search_jobs: () => searchReply(["111111"]) });
    const summary = await applyEasyApply(profile, { policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(summary.found).toBe(1);
    expect(summary.scanned).toBe(0);
    expect(h.calls.map((c) => c.tool)).toEqual(["search_jobs"]);
  });

  it("makes no application and writes nothing in a rehearsal", async () => {
    const f = files();
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => readReply("111111", "easy_apply"),
    });
    const summary = await applyEasyApply(profile, { dry: true, policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: f });

    expect(h.calls.some((c) => c.tool === "apply_to_job")).toBe(false);
    expect(summary.applied).toEqual([]);
    expect(existsSync(f.queue)).toBe(false);
    expect(existsSync(f.rows)).toBe(false);
  });

  it("holds the count cap and leaves the submission gap", async () => {
    const ids = ["111111", "222222", "333333"];
    const h = harness({
      search_jobs: () => searchReply(ids),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "easy_apply"),
      get_job_details: () => detailsReply("5 hours ago"),
      apply_to_job: () => applyReply(),
    });
    const summary = await applyEasyApply(profile, { policy, count: 2, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.applied).toHaveLength(2);
    const applies = h.calls.filter((c) => c.tool === "apply_to_job");
    expect(applies).toHaveLength(2);
    // The third posting is never read because the cap is reached.
    expect(h.calls.filter((c) => c.tool === "get_job_apply_url")).toHaveLength(2);
    // The run's clock only moves with sleeps, so the sleep between the two submissions is the gap.
    expect((applies[1]?.sleptBefore ?? 0) - (applies[0]?.sleptBefore ?? 0)).toBeGreaterThanOrEqual(HOURLY.easyApply.gapMs);
  });

  it("stops the whole step at the first bot check", async () => {
    const h = harness({
      search_jobs: () => searchReply(["111111"]),
      get_job_apply_url: () => JSON.stringify({ url: "https://www.linkedin.com/jobs/view/111111", section_errors: { apply: { message: "We detected unusual activity on your account" } } }),
    });
    const summary = await applyEasyApply(profile, { policy, call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.stopped).toMatch(/unusual activity/);
    expect(summary.applied).toEqual([]);
    expect(h.calls.some((c) => c.tool === "apply_to_job")).toBe(false);
  });

  it("skips a posting older than twelve hours and one whose age cannot be read", async () => {
    const h = harness({
      search_jobs: () => searchReply(["111111", "222222", "333333"]),
      get_job_apply_url: ({ job_id }) => readReply(job_id as string, "easy_apply"),
      get_job_details: ({ job_id }) => {
        if (job_id === "111111") return detailsReply("2 days ago");
        if (job_id === "222222") return JSON.stringify({ sections: { job_posting: "Acme Corp\nAndroid Engineer\nToronto, ON · 12 applicants" } });
        return detailsReply("5 hours ago");
      },
      apply_to_job: () => applyReply(),
    });
    const logs: string[] = [];
    const summary = await applyEasyApply(profile, { policy, log: (line) => logs.push(line), call: h.call, close: h.close, now: NOW, sleep: h.sleep, files: files() });

    expect(summary.tooOld).toBe(2);
    expect(summary.applied).toHaveLength(1);
    expect(summary.applied[0]?.url).toBe("https://www.linkedin.com/jobs/view/333333");
    expect(h.calls.filter((c) => c.tool === "apply_to_job")).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/skipped: posted 2 days ago/);
    expect(logs.join("\n")).toMatch(/posted date could not be read/);
  });
});
