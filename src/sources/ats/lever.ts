/** Lever public postings API. No auth. */
import { z } from "zod";
import { getJson } from "../../util/http.js";
import { canonicalUrl, easyApplyFromUrl, exactTime, jobId, type Job } from "../../jobs/normalize.js";

const LeverPosting = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  applyUrl: z.string().optional(),
  createdAt: z.number().optional(),
  categories: z
    .object({
      location: z.string().optional(),
      allLocations: z.array(z.string()).optional(),
      commitment: z.string().optional(),
      team: z.string().optional(),
    })
    .optional(),
  descriptionPlain: z.string().optional(),
  description: z.string().optional(),
  additionalPlain: z.string().optional(),
});

export function leverSlug(url: string): string | null {
  const m = /jobs\.lever\.co\/([^/?#]+)/i.exec(url);
  return m ? decodeURIComponent(m[1] as string) : null;
}

export function leverJobId(url: string): string | null {
  const m = /jobs\.lever\.co\/[^/]+\/([0-9a-f-]{36})/i.exec(url);
  return m ? (m[1] as string) : null;
}

export async function fetchLeverBoard(slug: string, companyFallback: string): Promise<Job[]> {
  const raw = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`, { cacheMs: 20 * 60_000 });
  if (!Array.isArray(raw)) return [];
  const out: Job[] = [];
  for (const item of raw) {
    const p = LeverPosting.safeParse(item);
    if (!p.success) continue;
    const j = p.data;
    const url = canonicalUrl(j.hostedUrl);
    const locations = [...new Set([j.categories?.location ?? "", ...(j.categories?.allLocations ?? [])].filter(Boolean))];
    const desc = [j.descriptionPlain ?? "", j.additionalPlain ?? ""].filter(Boolean).join("\n\n");
    out.push({
      id: jobId(url),
      source: `lever:${slug}`,
      company: companyFallback,
      title: j.text.trim(),
      url,
      ats: "lever",
      locations,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : null,
      postedAtExact: j.createdAt ? exactTime(new Date(j.createdAt).toISOString()) : null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: j.categories?.team ?? null,
      easyApply: easyApplyFromUrl(url),
      description: desc,
      descriptionSource: desc ? "api" : "none",
    });
  }
  return out;
}

export async function fetchLeverJob(slug: string, id: string): Promise<string | null> {
  try {
    const raw = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${id}`, { cacheMs: 6 * 60 * 60_000 });
    const p = LeverPosting.safeParse(raw);
    if (!p.success) return null;
    return [p.data.descriptionPlain ?? "", p.data.additionalPlain ?? ""].filter(Boolean).join("\n\n") || null;
  } catch {
    return null;
  }
}
