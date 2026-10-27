/**
 * freehire.me, asked through the openings-mcp server, for employers' postings no job board shows.
 * Its catalogue is a crawled copy, so it is used to find employers: every posting it crawled from a
 * board the tool reads names that board, and the board itself is then read directly. A posting is
 * kept only when freehire judges it fresh, not freshened by a re-listing, and not re-listed often,
 * and only from a board the tool can fill. Its date is when freehire first saw it, not the date the
 * board last bumped. The reply is data: only the fields below are read.
 */
import { z } from "zod";
import { FREEHIRE, MCP, ROOT } from "../config.js";
import { atsFromUrl, canonicalUrl, easyApplyFromUrl, jobId, type Job } from "../jobs/normalize.js";
import { McpClient } from "../mcp/client.js";
import type { Search } from "../profile/schema.js";
import type { Board } from "./companies.js";
import { logEvent } from "../log/events.js";

const Posting = z.object({
  title: z.string(),
  company: z.string().default(""),
  company_slug: z.string().optional(),
  url: z.string(),
  source: z.string().default(""),
  location: z.string().default(""),
  created_at: z.string().optional(),
  posted_at: z.string().optional(),
  is_tech: z.string().optional(),
  reality: z.object({ class: z.string().optional(), fake_freshness: z.boolean().optional(), repost_count: z.number().optional() }).default({}),
  enrichment: z.object({ employment_type: z.string().optional(), seniority: z.string().optional() }).default({}),
});
const Reply = z.object({ data: z.array(z.unknown()).default([]), total: z.number().optional() });

/** The boards whose own list the tool reads, by freehire's name for them. */
const READ_BOARDS: Record<string, Board["ats"]> = { greenhouse: "greenhouse", lever: "lever", ashby: "ashby", workable: "workable" };

export type FreehireCall = (args: Record<string, unknown>) => Promise<string>;
export type FreehireResult = { jobs: Job[]; boards: Board[]; calls: number; failures: string[] };

/** True when freehire's own signals say the posting is a live opening, not a stale or recycled one. */
export function looksAuthentic(p: z.infer<typeof Posting>): boolean {
  if (p.reality.class !== "fresh" || p.reality.fake_freshness) return false;
  if ((p.reality.repost_count ?? 1) > FREEHIRE.maxReposts) return false;
  if (p.is_tech && p.is_tech !== "tech") return false;
  if (p.enrichment.seniority === "intern" || p.enrichment.employment_type === "internship") return false;
  return (FREEHIRE.sources as readonly string[]).includes(p.source);
}

/** One reply's postings as jobs, and the boards they came from. */
export function freehireJobs(text: string): { jobs: Job[]; boards: Board[]; count: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { jobs: [], boards: [], count: 0 };
  }
  const reply = Reply.safeParse(raw);
  if (!reply.success) return { jobs: [], boards: [], count: 0 };
  const jobs: Job[] = [];
  const boards: Board[] = [];
  for (const item of reply.data.data) {
    const p = Posting.safeParse(item);
    if (!p.success || !looksAuthentic(p.data)) continue;
    let url: string;
    try {
      const u = new URL(p.data.url);
      if (u.protocol !== "https:") continue;
      url = canonicalUrl(u.toString());
    } catch {
      continue;
    }
    const first = p.data.created_at ?? p.data.posted_at;
    jobs.push({
      id: jobId(url),
      source: `freehire:${p.data.source}`,
      company: p.data.company.trim(),
      title: p.data.title.trim(),
      url,
      ats: atsFromUrl(url),
      locations: p.data.location ? [p.data.location] : [],
      postedAt: first && /^\d{4}-\d{2}-\d{2}/.test(first) ? first.slice(0, 10) : null,
      terms: [],
      sponsorship: "unknown",
      degrees: [],
      category: null,
      easyApply: easyApplyFromUrl(url),
    });
    const ats = READ_BOARDS[p.data.source];
    if (ats && p.data.company_slug) boards.push({ ats, slug: p.data.company_slug, company: p.data.company.trim() });
  }
  return { jobs, boards, count: reply.data.data.length };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks freehire about each of the portal's terms in its country, a page at a time. A failed call is reported and the next one is made. */
export async function searchFreehire(search: Search, maxAgeDays: number, o: { call?: FreehireCall; log?: (line: string) => void } = {}): Promise<FreehireResult> {
  const log = o.log ?? (() => {});
  const country = FREEHIRE.countries[search.countryIndeed];
  if (!country) {
    log(`[freehire] no country code for ${search.countryIndeed}, so freehire is not asked`);
    return { jobs: [], boards: [], calls: 0, failures: [] };
  }
  let client: McpClient | null = null;
  const call: FreehireCall =
    o.call ??
    (async (args) => {
      client ??= await McpClient.start(MCP.indeed, { startupMs: MCP.startupMs, name: "the openings MCP server", cwd: ROOT });
      return client.callTool(FREEHIRE.tool, args, MCP.callMs);
    });
  const jobs: Job[] = [];
  const boards: Board[] = [];
  const failures: string[] = [];
  let calls = 0;
  try {
    for (const term of search.terms) {
      for (let page = 0; page < FREEHIRE.maxPages; page++) {
        if (calls > 0) await wait(FREEHIRE.gapMs);
        calls++;
        let text: string;
        const t0 = Date.now();
        try {
          text = await call({
            q: term,
            countries: country,
            source: FREEHIRE.sources.join(","),
            reality: ["fresh"],
            is_tech: ["tech"],
            employment_type: [...FREEHIRE.employmentTypes],
            posted_within_days: maxAgeDays,
            sort: "posted_at",
            order: "desc",
            limit: FREEHIRE.pageSize,
            offset: page * FREEHIRE.pageSize,
          });
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          failures.push(`${term}: ${why}`);
          logEvent("freehire.call", { term, page, ok: false, ms: Date.now() - t0, error: why });
          log(`[freehire] ${term} failed: ${why}`);
          break;
        }
        const r = freehireJobs(text);
        logEvent("freehire.call", { term, page, country, ok: true, ms: Date.now() - t0, returned: r.count, kept: r.jobs.length, boards: r.boards.length });
        jobs.push(...r.jobs);
        boards.push(...r.boards);
        if (r.count < FREEHIRE.pageSize) break;
      }
    }
  } finally {
    (client as McpClient | null)?.close();
  }
  log(`[freehire] ${calls} calls, ${jobs.length} postings, ${new Set(boards.map((b) => `${b.ats}:${b.slug}`)).size} boards`);
  return { jobs, boards, calls, failures };
}
