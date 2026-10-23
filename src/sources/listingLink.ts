/**
 * The employer's own form behind an Indeed or LinkedIn listing, found through the board's MCP
 * server. The servers read the posting; they apply for no one. What comes back is a link, and the
 * form behind it is filled by the same Chrome flow as any other. A listing the servers have no
 * link for is left as it is: Chrome follows the page's Apply button when the job's turn comes.
 *
 * A server's reply is data. It is searched for links and nothing in it is followed or run.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { MCP, PATHS } from "../config.js";
import { atsFromUrl, hostIs, type Job } from "../jobs/normalize.js";
import { McpClient } from "../mcp/client.js";
import { safeUrl } from "../util/redact.js";
import { withStore, writeAtomic } from "../util/store.js";

export type Board = "linkedin" | "indeed";
export type Listing = { board: Board; id: string };

/** Asks one board's server about one listing and returns the text of its reply. */
export type ToolCall = (board: Board, args: Record<string, unknown>) => Promise<string>;
export type Caller = { call: ToolCall; close: () => void };

/** Which board and which posting a link is, or null when it is neither Indeed nor LinkedIn. */
export function listingOf(url: string): Listing | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (hostIs(host, "linkedin.com")) {
    const id = /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/.exec(u.pathname)?.[1] ?? u.searchParams.get("currentJobId") ?? undefined;
    return id && /^\d{6,}$/.test(id) ? { board: "linkedin", id } : null;
  }
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) {
    const id = u.searchParams.get("jk") ?? u.searchParams.get("vjk") ?? undefined;
    return id && /^[0-9a-f]{8,}$/i.test(id) ? { board: "indeed", id } : null;
  }
  return null;
}

const isBoardHost = (host: string) => MCP.boardHosts.some((d) => hostIs(host.toLowerCase(), d));
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|pdf)(?:$|\?)/i;
const LOOKS_LIKE_APPLY = /apply|application|job|career|position|opening|posting|requisition|opportunit|vacanc|recruit|hiring|gh_jid/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\)\]}]+/gi;

/** Every https link in a reply that is not the board's own, with the board's redirect links unwrapped. */
export function linksIn(text: string): string[] {
  const clean = text.replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
  const out: string[] = [];
  for (const m of clean.matchAll(URL_IN_TEXT)) {
    let u: URL;
    try {
      u = new URL(m[0].replace(/[.,;:!?]+$/, ""));
    } catch {
      continue;
    }
    if (isBoardHost(u.hostname)) {
      const inner = ["url", "u", "redirect", "target", "dest"].map((k) => u.searchParams.get(k)).find((v) => !!v && /^https?:\/\//i.test(v));
      if (!inner) continue;
      try {
        u = new URL(inner);
      } catch {
        continue;
      }
      if (isBoardHost(u.hostname)) continue;
    }
    if (u.protocol !== "https:" || ASSET.test(u.pathname + u.search)) continue;
    const href = u.toString();
    if (!out.includes(href)) out.push(href);
  }
  return out;
}

/**
 * The one link in a reply that is the employer's application, or null. A board the tool knows is
 * taken first. Any other link must look like a job or an application, so a company's home page or
 * a news article that the reply happens to mention is not taken for one.
 */
export function employerLinkIn(text: string): string | null {
  // A reply that names its apply link in a field is believed over any link its description mentions.
  try {
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object") {
      for (const key of ["apply_url", "applyUrl", "apply_link", "application_url"]) {
        const value = (data as Record<string, unknown>)[key];
        const named = typeof value === "string" ? linksIn(value)[0] : undefined;
        if (named) return named;
      }
    }
  } catch {
    /* not JSON: read it as text */
  }
  const links = linksIn(text);
  const known = links.find((l) => atsFromUrl(l) !== "other");
  if (known) return known;
  return links.find((l) => LOOKS_LIKE_APPLY.test(new URL(l).pathname + new URL(l).search)) ?? null;
}

/** The same job at the employer's link. The id stays: the record and the CSV are keyed by it. */
export function withEmployerLink<T extends { url: string; ats: string }>(job: T, url: string): T {
  return { ...job, url, ats: atsFromUrl(url) } as T;
}

const Cache = z.record(z.object({ url: z.string().nullable(), at: z.string() }));
type CacheFile = z.infer<typeof Cache>;

export function loadListingLinks(file = PATHS.listingLinks): CacheFile {
  if (!existsSync(file)) return {};
  try {
    const parsed = Cache.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The servers, started on first use and stopped together. A server that will not start is not tried again in this run. */
export function mcpCaller(log: (line: string) => void = () => {}): Caller {
  const clients = new Map<Board, Promise<McpClient | null>>();
  const clientFor = (board: Board) => {
    let p = clients.get(board);
    if (!p) {
      p = McpClient.start(MCP[board], { startupMs: MCP.startupMs, name: `the ${board} MCP server` }).catch((err: unknown) => {
        log(`[links] ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      clients.set(board, p);
    }
    return p;
  };
  return {
    async call(board, args) {
      const client = await clientFor(board);
      if (!client) throw new NotAvailable(board);
      return client.callTool(MCP[board].tool, args, MCP.callMs);
    },
    close() {
      for (const p of clients.values()) void p.then((c) => c?.close());
    },
  };
}

class NotAvailable extends Error {
  constructor(board: Board) {
    super(`the ${board} MCP server is not available`);
  }
}

export type ResolveOptions = {
  call: ToolCall;
  /** The Indeed country the searches belong to, in JobSpy's spelling. */
  country: string;
  now?: Date;
  log?: (line: string) => void;
  /** Leave the cache file alone. */
  dry?: boolean;
  cacheFile?: string;
  limit?: number;
};

/**
 * Asks the boards' servers for the employer link of each listing, at most `limit` of them, and
 * returns job id to link for those that have one. An answer is kept: a link for good, and "no link"
 * for MCP.retryAfterHours. A server that fails is not an answer and is not kept.
 */
export async function resolveListings(jobs: Pick<Job, "id" | "url">[], o: ResolveOptions): Promise<Map<string, string>> {
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const cache = loadListingLinks(o.cacheFile);
  const fresh: CacheFile = {};
  const found = new Map<string, string>();
  const down = new Set<Board>();
  let asked = 0;
  const limit = o.limit ?? MCP.maxPerRun;
  for (const job of jobs) {
    const listing = listingOf(job.url);
    if (!listing || down.has(listing.board)) continue;
    const key = `${listing.board}:${listing.id}`;
    const kept = cache[key];
    if (kept?.url) {
      found.set(job.id, kept.url);
      continue;
    }
    if (kept && now.getTime() - Date.parse(kept.at) < MCP.retryAfterHours * 3_600_000) continue;
    if (asked >= limit) break;
    asked++;
    try {
      const args = listing.board === "linkedin" ? { job_id: listing.id } : { job_key: listing.id, country: MCP.indeedCountries[o.country] ?? o.country };
      const url = employerLinkIn(await o.call(listing.board, args));
      fresh[key] = { url, at: now.toISOString() };
      if (url) {
        found.set(job.id, url);
        log(`[links] ${listing.board} ${listing.id} -> ${safeUrl(url)}`);
      }
    } catch (err) {
      if (err instanceof NotAvailable) down.add(listing.board);
      else log(`[links] ${listing.board} ${listing.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!o.dry && Object.keys(fresh).length) {
    withStore(() => writeAtomic(o.cacheFile ?? PATHS.listingLinks, JSON.stringify({ ...loadListingLinks(o.cacheFile), ...fresh }, null, 2) + "\n"));
  }
  return found;
}
