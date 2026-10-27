import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountGate } from "../src/accounts/capability.js";
import { jobId, type Job } from "../src/jobs/normalize.js";
import { entryFor } from "../src/jobs/queue.js";
import { pauseLinkedin, resumeLinkedin } from "../src/run/linkedinSession.js";
import { pickFresh } from "../src/run/hourlyApply.js";
import { Policy } from "../src/run/policy.js";

const NOW = new Date("2026-10-26T12:00:00");
const policy = Policy.parse({});
const job = (url: string, company: string): Job => ({
  id: jobId(url), source: "jobspy linkedin", company, title: "Android Engineer", url, ats: url.includes("linkedin") ? "linkedin" : "greenhouse",
  locations: ["Jersey City, NJ"], postedAt: "2026-10-26", terms: [], sponsorship: "unknown", degrees: [], category: null, easyApply: url.includes("linkedin") ? null : false,
});
const queued = (url: string, company: string) => ({ ...entryFor(job(url, company), null, null), applyable: true, status: "queued" as const });

describe("what a pause of the LinkedIn MCP does to the apply runs", () => {
  const before = process.env.JEV_SHARED_DIR;
  beforeEach(() => {
    process.env.JEV_SHARED_DIR = mkdtempSync(path.join(os.tmpdir(), "jev-pause-"));
  });
  afterEach(() => {
    if (before === undefined) delete process.env.JEV_SHARED_DIR;
    else process.env.JEV_SHARED_DIR = before;
  });

  it("refuses a LinkedIn link in the gate every run passes, and nothing else", () => {
    pauseLinkedin();
    const gate = accountGate();
    expect(gate("https://www.linkedin.com/jobs/view/4252026496")).toMatch(/LinkedIn MCP is paused/);
    expect(gate("https://uk.linkedin.com/jobs/view/4252026496")).toMatch(/paused/);
    expect(gate("https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
    expect(gate("https://www.indeed.com/viewjob?jk=5f2a9c1b7d3e4a60")).toBeNull();
    expect(gate("https://evil-linkedin.com.example.org/x")).toBeNull();
  });

  it("lets a LinkedIn link through again after a resume", () => {
    pauseLinkedin();
    resumeLinkedin();
    expect(accountGate()("https://www.linkedin.com/jobs/view/4252026496")).toBeNull();
  });

  it("leaves the hourly apply pass to the employer forms while paused", () => {
    const linkedin = queued("https://www.linkedin.com/jobs/view/4252026496", "Delta");
    const form = queued("https://boards.greenhouse.io/acme/jobs/1", "Acme");
    pauseLinkedin();
    const picked = pickFresh([linkedin, form], policy, NOW, 5, accountGate());
    expect(picked.map((e) => e.job.company)).toEqual(["Acme"]);
    resumeLinkedin();
    expect(pickFresh([linkedin, form], policy, NOW, 5, accountGate()).map((e) => e.job.company).sort()).toEqual(["Acme", "Delta"]);
  });
});
