/**
 * JobSpy, run from its own Docker image. Read-only: it asks Indeed and LinkedIn for public
 * postings and returns JSON. Nothing from a posting is executed, and the call carries no key:
 * the child process gets the same allow-listed environment as every other one.
 */
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { childEnv, HOURLY } from "../config.js";
import { canFill } from "../jobs/fillable.js";
import { atsFromUrl, canonicalUrl, dedupe, easyApplyFromUrl, jobId, toIsoDate, type Job } from "../jobs/normalize.js";
import type { Search } from "../profile/schema.js";

/** One row as JobSpy's pandas frame writes it: snake_case, with plenty of optional columns. */
export const JobspyRow = z
  .object({
    site: z.string().nullish(),
    title: z.string().nullish(),
    company: z.string().nullish(),
    location: z.string().nullish(),
    job_url: z.string().nullish(),
    job_url_direct: z.string().nullish(),
    /** A date string, or the epoch value pandas writes when the column is numeric. */
    date_posted: z.union([z.string(), z.number()]).nullish(),
    description: z.string().nullish(),
    is_remote: z.boolean().nullish(),
    /** JobSpy does not always write this; when it does, it is the board's own answer. */
    easy_apply: z.boolean().nullish(),
  })
  .passthrough();
export type JobspyRow = z.infer<typeof JobspyRow>;

/** Parses the JSON JobSpy prints. An empty output is no rows, and anything else is a hard error. */
export function parseJobspy(text: string): JobspyRow[] {
  const t = text.trim();
  if (!t) return [];
  const parsed = z.array(JobspyRow).safeParse(JSON.parse(t));
  if (!parsed.success) throw new Error(`JobSpy returned an unexpected shape: ${parsed.error.message}`);
  return parsed.data;
}

/** The date part, and the exact moment when the board gave one. */
export function postedOf(v: string | number | null | undefined): { postedAt: string | null; postedAtExact: string | null } {
  if (v === null || v === undefined || v === "") return { postedAt: null, postedAtExact: null };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { postedAt: null, postedAtExact: null };
    // pandas can write milliseconds, seconds or nanoseconds for the same column.
    const ms = v > 1e15 ? v / 1e6 : v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return { postedAt: null, postedAtExact: null };
    // A date-only column is written as midnight UTC. That is a day, not a time.
    const exact = d.toISOString();
    return { postedAt: toIsoDate(d), postedAtExact: exact.endsWith("T00:00:00.000Z") ? null : exact };
  }
  const text = v.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso) {
    // A date alone is a calendar day, not midnight UTC: do not turn it into a false exact time.
    const d = /T\d{2}:\d{2}/.test(text) ? new Date(text) : null;
    return { postedAt: iso[1] as string, postedAtExact: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null };
  }
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return { postedAt: null, postedAtExact: null };
  return { postedAt: toIsoDate(d), postedAtExact: d.toISOString() };
}

/** One JobSpy row as the tool's Job shape. Null when it has no usable title, company or link. */
export function mapJobspy(row: JobspyRow): Job | null {
  const title = row.title?.trim() ?? "";
  const company = row.company?.trim() ?? "";
  const direct = row.job_url_direct?.trim() ?? "";
  const plain = row.job_url?.trim() ?? "";
  const raw = /^https?:\/\//i.test(direct) ? direct : plain;
  if (!title || !company || !/^https?:\/\//i.test(raw)) return null;
  const url = canonicalUrl(raw);
  const locations = [row.location?.trim() ?? ""].filter(Boolean);
  if (!locations.length && row.is_remote) locations.push("Remote");
  const { postedAt, postedAtExact } = postedOf(row.date_posted);
  return {
    id: jobId(url),
    source: `jobspy ${row.site?.trim() || "board"}`,
    company,
    title,
    url,
    ats: atsFromUrl(url),
    locations,
    postedAt,
    postedAtExact,
    terms: [],
    sponsorship: "unknown",
    degrees: [],
    category: null,
    easyApply: row.easy_apply ?? easyApplyFromUrl(url),
    ...(row.description && row.description.trim().length >= 200 ? { description: row.description.trim(), descriptionSource: "api" as const } : {}),
  };
}

const rx = (source: string): RegExp => {
  try {
    return new RegExp(source, "i");
  } catch {
    return /$^/;
  }
};

/** True when the title is in the portal's role family. Every include must match, and no exclude may. */
export function titleWanted(title: string, search: Pick<Search, "titleInclude" | "titleExclude">): boolean {
  return search.titleInclude.every((p) => rx(p).test(title)) && !search.titleExclude.some((p) => rx(p).test(title));
}

/** A location with only "Remote", "Anywhere" or the whole United States says nothing about the area. */
const NOT_A_PLACE = /\b(remote|anywhere|hybrid|united states(?: of america)?|u\.?s\.?a?\.?)\b/gi;

/** True when at least one location belongs to the portal's area and the listing is not remote-only. */
export function locationWanted(locations: string[], search: Pick<Search, "locations" | "excludeRemoteOnly">): boolean {
  const text = locations.join(" | ");
  if (!text.trim()) return false;
  if (search.excludeRemoteOnly && !text.replace(NOT_A_PLACE, "").replace(/[\s,;|/-]+/g, " ").trim()) return false;
  return search.locations.some((l) => l.accept.some((p) => rx(p).test(text)));
}

/** The employer key the portal excludes, if any. */
export function companyExcluded(company: string, exclude: readonly string[]): boolean {
  const c = company.trim().toLowerCase();
  return exclude.some((x) => c.includes(x.trim().toLowerCase()) && x.trim().length > 0);
}

/**
 * Deduplicates by posting id, then by company, title and location. When the same job came back
 * from Indeed and LinkedIn and one record points at the employer's own form, that record wins.
 */
export function dedupeJobspy(jobs: Job[]): Job[] {
  const byId = dedupe(jobs);
  const groups = new Map<string, Job[]>();
  for (const j of byId) {
    const key = `${j.company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${j.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${j.locations.join(",").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    const list = groups.get(key) ?? [];
    list.push(j);
    groups.set(key, list);
  }
  const out: Job[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => Number(canFill(b)) - Number(canFill(a)) || a.url.length - b.url.length);
    out.push(list[0] as Job);
  }
  return out;
}

/** Starts one JobSpy call. Injected in tests so nothing runs Docker there. */
export type JobspyRunner = (args: string[], timeoutMs: number) => { ok: boolean; stdout: string; error: string };

export const dockerRunner: JobspyRunner = (args, timeoutMs) => {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: childEnv() });
  const stderr = String(r.stderr ?? "").trim();
  if (r.error) return { ok: false, stdout: "", error: r.error.message };
  if (r.status !== 0) return { ok: false, stdout: "", error: stderr.slice(0, 300) || `docker exited ${String(r.status)}` };
  return { ok: true, stdout: String(r.stdout ?? ""), error: "" };
};

export type JobspyResult = { jobs: Job[]; calls: number; failures: string[] };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the portal's queries, one call at a time, and returns the postings that match its roles
 * and area. A failed call is reported and the run carries on with the next one.
 */
export async function searchJobspy(
  search: Search,
  o: { runner?: JobspyRunner; log?: (line: string) => void; hoursOld?: number } = {},
): Promise<JobspyResult> {
  const runner = o.runner ?? dockerRunner;
  const log = o.log ?? (() => {});
  const limit = Math.min(search.maxQueries, HOURLY.maxQueries);
  const queries: { term: string; location: string; distance: number }[] = [];
  for (const term of search.terms) {
    for (const location of search.locations) {
      if (queries.length >= limit) break;
      queries.push({ term, location: location.query, distance: location.distance });
    }
    if (queries.length >= limit) break;
  }

  const found: Job[] = [];
  const failures: string[] = [];
  let calls = 0;
  for (const q of queries) {
    if (calls > 0 && search.gapMs > 0) await wait(search.gapMs);
    calls++;
    const args = [
      "run",
      "--rm",
      HOURLY.dockerImage,
      "--site_name",
      search.sites.join(","),
      "--search_term",
      q.term,
      "--location",
      q.location,
      "--distance",
      String(q.distance),
      "--results_wanted",
      String(search.resultsWanted),
      "--hours_old",
      String(o.hoursOld ?? search.hoursOld),
      "--country_indeed",
      search.countryIndeed,
      "--format",
      "json",
    ];
    const r = runner(args, HOURLY.timeoutMs);
    if (!r.ok) {
      failures.push(`${q.term} in ${q.location}: ${r.error}`);
      log(`[jobspy] ${q.term} in ${q.location} failed: ${r.error}`);
      continue;
    }
    let rows: JobspyRow[];
    try {
      rows = parseJobspy(r.stdout);
    } catch (err) {
      failures.push(`${q.term} in ${q.location}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let kept = 0;
    for (const row of rows) {
      const job = mapJobspy(row);
      if (!job) continue;
      if (!titleWanted(job.title, search)) continue;
      if (!locationWanted(job.locations, search)) continue;
      if (companyExcluded(job.company, search.excludeCompanies)) continue;
      found.push(job);
      kept++;
    }
    log(`[jobspy] ${q.term} in ${q.location}: ${rows.length} rows, ${kept} kept`);
  }
  return { jobs: dedupeJobspy(found), calls, failures };
}
