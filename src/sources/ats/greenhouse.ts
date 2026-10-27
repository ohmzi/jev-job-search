/** Greenhouse public job board API. No auth. */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { htmlToText } from "../../util/text.js";
import { canonicalUrl, easyApplyFromUrl, exactTime, jobId, type Job } from "../../jobs/normalize.js";

const GhJob = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  location: z.object({ name: z.string() }).optional(),
  offices: z.array(z.object({ name: z.string().nullable(), location: z.string().nullable() })).optional(),
  first_published: z.string().optional(),
  updated_at: z.string().optional(),
  content: z.string().optional(),
  company_name: z.string().optional(),
});
const GhBoard = z.object({ jobs: z.array(z.unknown()) });

export function greenhouseSlug(url: string): string | null {
  const m = /greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i.exec(url);
  if (m && m[1] !== "embed" && m[1] !== "v1") return m[1] as string;
  const forParam = /[?&]for=([a-z0-9_-]+)/i.exec(url);
  return forParam ? (forParam[1] as string) : null;
}

export function greenhouseJobId(url: string): string | null {
  const m = /\/jobs\/(\d+)/.exec(url) ?? /[?&]gh_jid=(\d+)/.exec(url);
  return m ? (m[1] as string) : null;
}

export async function fetchGreenhouseBoard(slug: string, companyFallback: string): Promise<Job[]> {
  const raw = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`, {
    cacheMs: 20 * 60_000,
  });
  const board = GhBoard.parse(raw);
  const out: Job[] = [];
  for (const item of board.jobs) {
    const p = GhJob.safeParse(item);
    if (!p.success) continue;
    const j = p.data;
    const url = canonicalUrl(j.absolute_url);
    const locations = [
      ...(j.location?.name ? [j.location.name] : []),
      ...(j.offices ?? []).map((o) => o.location ?? o.name ?? "").filter(Boolean),
    ];
    out.push({
      id: jobId(url),
      source: `greenhouse:${slug}`,
      company: j.company_name ?? companyFallback,
      title: j.title.trim(),
      url,
      ats: "greenhouse",
      locations: [...new Set(locations)],
      postedAt: (j.first_published ?? j.updated_at ?? "").slice(0, 10) || null,
      postedAtExact: exactTime(j.first_published),
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: null,
      easyApply: easyApplyFromUrl(url),
      description: j.content ? htmlToText(j.content) : "",
      descriptionSource: j.content ? "api" : "none",
    });
  }
  return out;
}

export async function fetchGreenhouseJob(slug: string, id: string): Promise<string | null> {
  try {
    const raw = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${id}`, {
      cacheMs: 6 * 60 * 60_000,
    });
    const j = GhJob.safeParse(raw);
    return j.success && j.data.content ? htmlToText(j.data.content) : null;
  } catch {
    return null;
  }
}
