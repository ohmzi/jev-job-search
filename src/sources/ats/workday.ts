/** Workday's public posting endpoint, the one its own careers page reads. No auth, one posting at a time. */
import { z } from "zod";
import { ATS_SEARCH } from "../../config.js";
import { getJson, postJson } from "../../util/http.js";
import { canonicalUrl, easyApplyFromUrl, jobId, type Job } from "../../jobs/normalize.js";
import { htmlToText } from "../../util/text.js";

const WorkdayPosting = z.object({
  jobPostingInfo: z.object({
    title: z.string(),
    jobDescription: z.string().default(""),
    location: z.string().default(""),
    additionalLocations: z.array(z.string()).default([]),
    startDate: z.string().optional(),
    canApply: z.union([z.string(), z.boolean()]).optional(),
    externalUrl: z.string().optional(),
  }),
  hiringOrganization: z.object({ name: z.string().default("") }).default({ name: "" }),
});

/**
 * The parts of a Workday posting link: the employer, its careers site and the posting's own path.
 * https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Toronto/Software-Intern_R123
 */
export function workdayParts(url: string): { origin: string; tenant: string; site: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const tenant = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(u.hostname)?.[1];
  const m = /^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+?)(?:\/apply(?:\/[A-Za-z]+)?)?\/?$/.exec(u.pathname);
  if (!tenant || !m?.[1] || !m[2]) return null;
  return { origin: u.origin, tenant: tenant.toLowerCase(), site: m[1], path: m[2] };
}

/** An employer's Workday careers site, by any link into it: https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/... reads https://acme.wd5.myworkdayjobs.com/Careers. */
export function workdaySite(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const tenant = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(u.hostname)?.[1];
  const site = /^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)/.exec(u.pathname)?.[1];
  if (!tenant || !site || site === "wday") return null;
  return `${u.origin}/${site}`;
}

const SearchReply = z.object({
  total: z.number().optional(),
  jobPostings: z.array(z.object({ title: z.string(), externalPath: z.string(), postedOn: z.string().optional() })).default([]),
});

/** How many days ago Workday says a posting went up: "Posted Today" is 0, "Posted 30+ Days Ago" is more than 30. */
export function postedDaysAgo(postedOn: string | undefined): number | null {
  if (!postedOn) return null;
  if (/today/i.test(postedOn)) return 0;
  if (/yesterday/i.test(postedOn)) return 1;
  const m = /(\d+)(\+)?\s*days?/i.exec(postedOn);
  if (!m) return null;
  return Number(m[1]) + (m[2] ? 1 : 0);
}

/** One page of a site's search, as links to postings with their age and title. */
export function workdaySearchPage(raw: unknown, site: string): { url: string; title: string; daysAgo: number | null }[] {
  const p = SearchReply.safeParse(raw);
  if (!p.success) return [];
  return p.data.jobPostings
    .filter((j) => j.externalPath.startsWith("/job/"))
    .map((j) => ({ url: `${site}${j.externalPath}`, title: j.title.trim(), daysAgo: postedDaysAgo(j.postedOn) }));
}

/**
 * Searches one employer's Workday site for each term and reads the postings that pass `wanted`
 * and are fresh enough. Workday does not sort by date, so each term reads a bounded number of pages.
 */
export async function searchWorkdaySite(
  site: string,
  terms: readonly string[],
  wanted: (title: string) => boolean,
  maxAgeDays: number,
): Promise<Job[]> {
  const u = new URL(site);
  const tenant = u.hostname.split(".")[0] as string;
  const name = u.pathname.slice(1);
  const endpoint = `${u.origin}/wday/cxs/${tenant}/${name}/jobs`;
  const links = new Map<string, string>();
  for (const term of terms) {
    for (let page = 0; page < ATS_SEARCH.workdayMaxPages; page++) {
      const raw = await postJson(endpoint, { appliedFacets: {}, limit: ATS_SEARCH.workdayPageSize, offset: page * ATS_SEARCH.workdayPageSize, searchText: term }, { cacheMs: 20 * 60_000 });
      const hits = workdaySearchPage(raw, site);
      for (const h of hits) if (wanted(h.title) && (h.daysAgo === null || h.daysAgo <= maxAgeDays)) links.set(h.url, h.title);
      if (hits.length < ATS_SEARCH.workdayPageSize) break;
    }
  }
  const out: Job[] = [];
  for (const url of links.keys()) {
    try {
      const job = await fetchWorkdayPosting(url);
      if (job) out.push(job);
    } catch {
      /* a posting that closed between the search and the read is not a job */
    }
  }
  return out;
}

const apiUrl = (p: { origin: string; tenant: string; site: string; path: string }) => `${p.origin}/wday/cxs/${p.tenant}/${p.site}/job/${p.path}`;

/** A legal entity's name as a company name: "207 Acme Technology Canada ULC" reads "Acme Technology Canada ULC". */
const companyName = (legal: string, tenant: string) => legal.replace(/^\d+\s+/, "").trim() || tenant.charAt(0).toUpperCase() + tenant.slice(1);

/** One posting by its link. Null when the link is not a Workday posting, or the posting is closed or gone. */
export async function fetchWorkdayPosting(url: string): Promise<Job | null> {
  const parts = workdayParts(url);
  return parts ? workdayJob(await getJson(apiUrl(parts), { cacheMs: 20 * 60_000 }), url) : null;
}

/** What Workday says about a posting, as a job. Null for a reply that is not a posting, or a posting that takes no applications. */
export function workdayJob(raw: unknown, url: string): Job | null {
  const parts = workdayParts(url);
  if (!parts) return null;
  const p = WorkdayPosting.safeParse(raw);
  if (!p.success || String(p.data.jobPostingInfo.canApply ?? "true").toLowerCase() === "false") return null;
  const info = p.data.jobPostingInfo;
  // The link is kept as it was given, less the apply step, so the same posting from a list gets the same id.
  const link = canonicalUrl(url.replace(/\/apply(\/[A-Za-z]+)?\/?(?=$|[?#])/, ""));
  const description = htmlToText(info.jobDescription);
  return {
    id: jobId(link),
    source: `workday:${parts.tenant}`,
    company: companyName(p.data.hiringOrganization.name, parts.tenant),
    title: info.title.trim(),
    url: link,
    ats: "workday",
    locations: [...new Set([info.location, ...info.additionalLocations].filter(Boolean))],
    postedAt: info.startDate && /^\d{4}-\d{2}-\d{2}/.test(info.startDate) ? info.startDate.slice(0, 10) : null,
    terms: [],
    sponsorship: "unknown",
    degrees: [],
    category: null,
    easyApply: easyApplyFromUrl(link),
    description,
    descriptionSource: description ? "api" : "none",
  };
}

/** The words of one posting, for rating. */
export async function fetchWorkdayJob(url: string): Promise<string | null> {
  const parts = workdayParts(url);
  if (!parts) return null;
  try {
    const p = WorkdayPosting.safeParse(await getJson(apiUrl(parts), { cacheMs: 6 * 60 * 60_000 }));
    return p.success ? htmlToText(p.data.jobPostingInfo.jobDescription) || null : null;
  } catch {
    return null;
  }
}
