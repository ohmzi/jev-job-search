/** Workable's public job widget, the list its own careers page reads. No auth, one call per employer. */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { canonicalUrl, easyApplyFromUrl, jobId, type Job } from "../../jobs/normalize.js";
import { htmlToText } from "../../util/text.js";

const WorkableJob = z.object({
  title: z.string(),
  shortcode: z.string(),
  employment_type: z.string().optional(),
  telecommuting: z.boolean().optional(),
  department: z.string().optional(),
  published_on: z.string().optional(),
  created_at: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  locations: z.array(z.object({ city: z.string().optional(), region: z.string().optional(), country: z.string().optional(), hidden: z.boolean().optional() })).optional(),
  description: z.string().optional(),
});
const WorkableBoard = z.object({ name: z.string().optional(), jobs: z.array(z.unknown()) });

/** The employer's account name in a Workable link: https://apply.workable.com/acme/j/ABC123/ reads "acme". */
export function workableSlug(url: string): string | null {
  const m = /apply\.workable\.com\/(?!j\/|api\/)([a-z0-9_-]+)/i.exec(url);
  return m ? (m[1] as string).toLowerCase() : null;
}

const place = (l: { city?: string | undefined; region?: string | undefined; country?: string | undefined }) => [l.city, l.region, l.country].filter((s) => !!s && s.trim()).join(", ");

/** What Workable's widget says about an employer's openings, as jobs. */
export function workableJobs(raw: unknown, slug: string, companyFallback: string): Job[] {
  const board = WorkableBoard.safeParse(raw);
  if (!board.success) return [];
  const company = board.data.name?.trim() || companyFallback;
  const out: Job[] = [];
  for (const item of board.data.jobs) {
    const p = WorkableJob.safeParse(item);
    if (!p.success) continue;
    const j = p.data;
    const url = canonicalUrl(`https://apply.workable.com/${slug}/j/${j.shortcode}/`);
    const listed = (j.locations ?? []).filter((l) => !l.hidden).map(place).filter(Boolean);
    const locations = [...new Set(listed.length ? listed : [place({ city: j.city, region: j.state, country: j.country })].filter(Boolean))];
    if (j.telecommuting && !locations.some((l) => /remote/i.test(l))) locations.push("Remote");
    const description = j.description ? htmlToText(j.description) : "";
    const posted = j.published_on ?? j.created_at;
    out.push({
      id: jobId(url),
      source: `workable:${slug}`,
      company,
      title: j.title.trim(),
      url,
      ats: "workable",
      locations,
      postedAt: posted && /^\d{4}-\d{2}-\d{2}/.test(posted) ? posted.slice(0, 10) : null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: j.department ?? null,
      easyApply: easyApplyFromUrl(url),
      description,
      descriptionSource: description ? "api" : "none",
    });
  }
  return out;
}

export async function fetchWorkableBoard(slug: string, companyFallback: string): Promise<Job[]> {
  const raw = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`, { cacheMs: 20 * 60_000 });
  return workableJobs(raw, slug, companyFallback);
}
