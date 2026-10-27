/**
 * SimplifyJobs keeps a machine-readable listings.json behind both of its
 * READMEs (Summer2027-Internships and New-Grad-Positions). Fields observed:
 * source, category, company_name, id, title, active, terms (internships only),
 * date_updated, date_posted (unix seconds), url, locations, company_url,
 * is_visible, sponsorship, degrees.
 */
import { z } from "zod";
import { DISCOVER } from "../config.js";
import { getJson } from "../util/http.js";
import { atsFromUrl, canonicalUrl, easyApplyFromUrl, jobId, toIsoDate, type Job, type Sponsorship } from "../jobs/normalize.js";

const Listing = z.object({
  category: z.string().nullable().optional(),
  company_name: z.string(),
  title: z.string(),
  active: z.boolean(),
  is_visible: z.boolean().optional(),
  terms: z.array(z.string()).optional(),
  date_posted: z.number(),
  date_updated: z.number().optional(),
  url: z.string(),
  locations: z.array(z.string()).optional(),
  sponsorship: z.string().optional(),
  degrees: z.array(z.string()).optional(),
});
export type SimplifyListing = z.infer<typeof Listing>;

export const SOFTWARE_CATEGORIES = new Set(["Software", "Software Engineering"]);

export function sponsorshipFrom(s: string | undefined): Sponsorship {
  switch (s) {
    case "Offers Sponsorship": return "offers";
    case "Does Not Offer Sponsorship": return "none";
    case "U.S. Citizenship is Required": return "citizenship";
    default: return "unknown";
  }
}

export function parseSimplify(raw: unknown, source: string): Job[] {
  const arr = z.array(z.unknown()).parse(raw);
  const out: Job[] = [];
  for (const item of arr) {
    const p = Listing.safeParse(item);
    if (!p.success) continue;
    const l = p.data;
    if (!l.active || l.is_visible === false) continue;
    if (l.category && !SOFTWARE_CATEGORIES.has(l.category)) continue;
    const url = canonicalUrl(l.url);
    out.push({
      id: jobId(url),
      source,
      company: l.company_name.trim(),
      title: l.title.trim(),
      url,
      ats: atsFromUrl(url),
      locations: (l.locations ?? []).map((s) => s.trim()).filter(Boolean),
      postedAt: toIsoDate(new Date(l.date_posted * 1000)),
      terms: l.terms ?? [],
      sponsorship: sponsorshipFrom(l.sponsorship),
      degrees: l.degrees ?? [],
      category: l.category ?? null,
      easyApply: easyApplyFromUrl(url),
    });
  }
  return out;
}

export async function fetchSimplify(): Promise<Job[]> {
  const [interns, grads] = await Promise.all([
    getJson(DISCOVER.sources.simplifyInternships, { cacheMs: 30 * 60_000 }),
    getJson(DISCOVER.sources.simplifyNewGrad, { cacheMs: 30 * 60_000 }),
  ]);
  return [...parseSimplify(interns, "simplify-internships"), ...parseSimplify(grads, "simplify-newgrad")];
}
