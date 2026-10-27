import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSheetCsv } from "../src/sources/sheetImport.js";
import { greenhouseJobId, greenhouseSlug } from "../src/sources/ats/greenhouse.js";
import { ashbyJobId, ashbySlug } from "../src/sources/ats/ashby.js";
import { leverJobId, leverSlug } from "../src/sources/ats/lever.js";
import { boardsFromJobs } from "../src/sources/companies.js";
import { workableJobs, workableSlug } from "../src/sources/ats/workable.js";
import { postedDaysAgo, workdaySearchPage, workdaySite } from "../src/sources/ats/workday.js";
import { freehireJobs } from "../src/sources/freehire.js";
import { boardJobWanted, boardTitleWanted, isEarlyCareerTitle } from "../src/discover.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("sheet import", () => {
  it("turns unapplied rows into jobs", () => {
    const csv = 'Company,What They Do,Role / Title,Location,Visa / Work Auth,Job Link,App. Status\r\nStripe,Payments,Software Engineer New Grad,"Toronto, ON",Canada,https://stripe.com/jobs/search?gh_jid=8157838,Not applied\r\nZip,Procurement,SWE,Toronto,Canada,https://jobs.ashbyhq.com/zip/b5242472,Applied\r\n';
    const jobs = parseSheetCsv(csv);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ company: "Stripe", title: "Software Engineer New Grad", ats: "greenhouse", source: "sheet" });
  });
});

describe("ATS url helpers and board discovery", () => {
  it("extracts slugs and ids", () => {
    expect(greenhouseSlug("https://job-boards.greenhouse.io/doordashcanada/jobs/8170944")).toBe("doordashcanada");
    expect(greenhouseJobId("https://job-boards.greenhouse.io/doordashcanada/jobs/8170944")).toBe("8170944");
    expect(greenhouseJobId("https://stripe.com/jobs/search?gh_jid=8157838")).toBe("8157838");
    expect(leverSlug("https://jobs.lever.co/matchgroup/69396299-e587-4063-aef6-0ce2fd66e9ee/apply")).toBe("matchgroup");
    expect(leverJobId("https://jobs.lever.co/matchgroup/69396299-e587-4063-aef6-0ce2fd66e9ee/apply")).toBe("69396299-e587-4063-aef6-0ce2fd66e9ee");
    expect(ashbySlug("https://jobs.ashbyhq.com/Superhuman%20Platform%20Inc/5f1f25ee-709d-4ae0-ada4-d1f243bde89c")).toBe("Superhuman Platform Inc");
    expect(ashbyJobId("https://jobs.ashbyhq.com/cohere/8c035d3d-081d-4c8a-914a-72f4efaad254")).toBe("8c035d3d-081d-4c8a-914a-72f4efaad254");
  });
  it("derives boards from job urls without duplicating seeds", () => {
    const jobs = [
      { ats: "greenhouse", url: "https://job-boards.greenhouse.io/doordashcanada/jobs/1", company: "DoorDash" },
      { ats: "ashby", url: "https://jobs.ashbyhq.com/Superhuman%20Platform%20Inc/8c035d3d-081d-4c8a-914a-72f4efaad254", company: "Superhuman" },
      { ats: "workable", url: "https://apply.workable.com/acme/j/ABC123/", company: "Acme" },
      { ats: "workday", url: "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin/Engineer_R1", company: "Acme" },
      { ats: "other", url: "https://careers.example.com/1", company: "Example" },
    ];
    const boards = boardsFromJobs(jobs, [{ ats: "greenhouse", slug: "doordashcanada", company: "DoorDash" }], [{ ats: "lever", slug: "plaid", company: "Plaid" }]);
    expect(boards.filter((b) => b.slug === "doordashcanada")).toHaveLength(1);
    expect(boards.some((b) => b.ats === "ashby" && /Superhuman/.test(b.slug))).toBe(true);
    expect(boards).toContainEqual({ ats: "workable", slug: "acme", company: "Acme" });
    expect(boards).toContainEqual({ ats: "workday", slug: "https://acme.wd5.myworkdayjobs.com/Careers", company: "Acme" });
    expect(boards).toContainEqual({ ats: "lever", slug: "plaid", company: "Plaid" });
    expect(boards).toHaveLength(5);
  });
});

describe("Workday postings", () => {
  it("reads the parts of a posting link, with or without a locale and an apply step", async () => {
    const { workdayParts } = await import("../src/sources/ats/workday.js");
    expect(workdayParts("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Software-Intern_R1")).toEqual({ origin: "https://acme.wd5.myworkdayjobs.com", tenant: "acme", site: "Careers", path: "Toronto/Software-Intern_R1" });
    expect(workdayParts("https://acme.wd5.myworkdayjobs.com/Careers/job/Toronto/Software-Intern_R1/apply/applyManually")?.path).toBe("Toronto/Software-Intern_R1");
    expect(workdayParts("https://acme.wd5.myworkdayjobs.com/Careers")).toBeNull();
    expect(workdayParts("https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
  });

  it("turns Workday's own posting data into a job", async () => {
    const { workdayJob } = await import("../src/sources/ats/workday.js");
    const raw = JSON.parse(readFileSync(new URL("./fixtures/workday-posting.json", import.meta.url), "utf8")) as { jobPostingInfo: Record<string, unknown> };
    const link = "https://altera.wd1.myworkdayjobs.com/altera/job/Toronto-Ontario-Canada/Software-Engineer---Intern_R03193";
    const job = workdayJob(raw, `${link}/apply/applyManually`);
    expect(job).toMatchObject({ title: "Software Engineer - Intern", company: "Altera Semiconductor Technology Canada ULC", ats: "workday", url: link, locations: ["Toronto, Ontario, Canada"], source: "workday:altera", descriptionSource: "api" });
    expect(job?.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(job?.description).not.toMatch(/<\/?[a-z]/i);
    // A posting that takes no applications is not a job to queue.
    expect(workdayJob({ ...raw, jobPostingInfo: { ...raw.jobPostingInfo, canApply: "False" } }, link)).toBeNull();
    expect(workdayJob({ nothing: true }, link)).toBeNull();
  });
});

describe("Workable boards", () => {
  it("reads the account name from a link, not the short posting link", () => {
    expect(workableSlug("https://apply.workable.com/huggingface/j/81B46579FE/")).toBe("huggingface");
    expect(workableSlug("https://apply.workable.com/j/81B46579FE")).toBeNull();
    expect(workableSlug("https://apply.workable.com/api/v1/widget/accounts/x")).toBeNull();
  });

  it("turns Workable's widget list into jobs on the employer's own links", () => {
    const jobs = workableJobs(JSON.parse(fixture("workable-board.json")), "huggingface", "fallback");
    expect(jobs).toHaveLength(3);
    expect(jobs[1]).toMatchObject({ company: "Hugging Face", ats: "workable", url: "https://apply.workable.com/huggingface/j/" + JSON.parse(fixture("workable-board.json")).jobs[1].shortcode, source: "workable:huggingface", descriptionSource: "api" });
    expect(jobs[1]?.locations).toEqual(["New York, New York, United States", "Remote"]);
    expect(jobs[1]?.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(jobs[1]?.description).not.toMatch(/<\/?[a-z]/i);
    // A location the employer hid falls back to the posting's own city.
    expect(jobs[2]?.locations[0]).toMatch(/Paris/);
    expect(workableJobs({ nothing: true }, "x", "x")).toEqual([]);
  });
});

describe("Workday site search", () => {
  it("names the careers site from any link into it", () => {
    expect(workdaySite("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Austin/Engineer_R1")).toBe("https://acme.wd5.myworkdayjobs.com/Careers");
    expect(workdaySite("https://acme.wd5.myworkdayjobs.com/Careers")).toBe("https://acme.wd5.myworkdayjobs.com/Careers");
    expect(workdaySite("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs")).toBeNull();
    expect(workdaySite("https://boards.greenhouse.io/acme")).toBeNull();
  });

  it("reads Workday's posted-on words as days", () => {
    expect(postedDaysAgo("Posted Today")).toBe(0);
    expect(postedDaysAgo("Posted Yesterday")).toBe(1);
    expect(postedDaysAgo("Posted 3 Days Ago")).toBe(3);
    expect(postedDaysAgo("Posted 30+ Days Ago")).toBe(31);
    expect(postedDaysAgo(undefined)).toBeNull();
  });

  it("turns a search page into posting links on the site", () => {
    const site = "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite";
    const hits = workdaySearchPage(JSON.parse(fixture("workday-search.json")), site);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.url.startsWith(`${site}/job/`)).toBe(true);
    expect(workdaySite(hits[0]?.url ?? "")).toBe(site);
    expect(hits[0]?.daysAgo).toBe(31);
    expect(workdaySearchPage({ nope: 1 }, site)).toEqual([]);
  });
});

describe("freehire", () => {
  it("keeps fresh postings from boards the tool fills, dated when first seen, and names their boards", () => {
    const r = freehireJobs(fixture("freehire-search.json"));
    expect(r.count).toBe(3);
    // The aggregator listing is left out.
    expect(r.jobs.map((j) => j.company)).toEqual(["Roblox", "Roblox"]);
    expect(r.jobs[0]).toMatchObject({ ats: "greenhouse", source: "freehire:greenhouse", postedAt: "2026-10-14", locations: ["San Mateo, CA, United States"] });
    expect(r.jobs[0]?.url).not.toMatch(/utm_source/);
    expect(r.boards).toContainEqual({ ats: "greenhouse", slug: "roblox", company: "Roblox" });
  });

  it("leaves out stale, freshened, often re-listed and intern postings", () => {
    const base = JSON.parse(fixture("freehire-search.json")).data[0];
    const one = (patch: Record<string, unknown>) => freehireJobs(JSON.stringify({ data: [{ ...base, ...patch }] })).jobs.length;
    expect(one({})).toBe(1);
    expect(one({ reality: { class: "stale" } })).toBe(0);
    expect(one({ reality: { class: "fresh", fake_freshness: true } })).toBe(0);
    expect(one({ reality: { class: "fresh", repost_count: 9 } })).toBe(0);
    expect(one({ enrichment: { seniority: "intern" } })).toBe(0);
    expect(one({ url: "http://careers.roblox.com/jobs/1" })).toBe(0);
    expect(freehireJobs("not json").jobs).toEqual([]);
  });
});

describe("board postings for an experienced search", () => {
  const search = {
    portal: "fullstack-nj", titleInclude: ["engineer|developer"], titleExclude: ["manager"], terms: ["software engineer"],
    sites: ["indeed", "linkedin"] as ("indeed" | "linkedin")[], countryIndeed: "USA", apply: false, resultsWanted: 50, hoursOld: 1, maxQueries: 12, gapMs: 0, minuteOffset: 0,
    locations: [{ query: "Jersey City, NJ", distance: 50, accept: ["\\bNJ\\b|New Jersey|New York|\\bNY\\b"] }], excludeRemoteOnly: true, excludeCompanies: ["Acme Staffing"],
  };

  it("drops intern and new grad titles whatever the portal says", () => {
    for (const t of ["Software Engineer Intern", "Software Engineering Internship", "New Grad Software Engineer", "Software Engineer, Early Career", "Co-op Developer", "Software Engineer - University Graduate"]) {
      expect(isEarlyCareerTitle(t)).toBe(true);
      expect(boardTitleWanted(t, search)).toBe(false);
      expect(boardTitleWanted(t)).toBe(false);
    }
    expect(isEarlyCareerTitle("Senior Software Engineer, Internal Tools")).toBe(false);
    expect(isEarlyCareerTitle("Staff Engineer, International Payments")).toBe(false);
  });

  it("keeps experienced titles in the portal's area and leaves out the rest", () => {
    const job = (title: string, locations: string[], company = "Stripe") => ({ title, locations, company });
    expect(boardJobWanted(job("Senior Software Engineer", ["New York, NY"]), search)).toBe(true);
    expect(boardJobWanted(job("Senior Software Engineer", ["Austin, TX"]), search)).toBe(false);
    expect(boardJobWanted(job("Senior Software Engineer", ["Remote"]), search)).toBe(false);
    expect(boardJobWanted(job("Engineering Manager", ["New York, NY"]), search)).toBe(false);
    expect(boardJobWanted(job("Senior Software Engineer", ["Jersey City, NJ"], "Acme Staffing LLC"), search)).toBe(false);
    // Without a portal, any software title anywhere is kept.
    expect(boardJobWanted(job("Senior Backend Developer", ["Berlin"]))).toBe(true);
    expect(boardJobWanted(job("Account Executive", ["Berlin"]))).toBe(false);
  });
});
