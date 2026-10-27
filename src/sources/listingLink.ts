/**
 * The employer's own form behind an Indeed or LinkedIn listing, found through the board's MCP
 * server. This lookup reads the posting and applies for no one. What comes back is a link, and the
 * form behind it is filled by the same Chrome flow as any other. A listing the servers have no
 * link for is left as it is: Chrome follows the page's Apply button when the job's turn comes.
 *
 * A server's reply is data. It is searched for links and nothing in it is followed or run.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { MCP, PATHS, ROOT } from "../config.js";
import { atsFromUrl, hostIs, jobId, type Job } from "../jobs/normalize.js";
import { McpClient } from "../mcp/client.js";
import { linkedinGate, markLoginRequired, type SessionDirs } from "../run/linkedinSession.js";
import { loginNoticeIn } from "./loginNotice.js";
import { safeUrl } from "../util/redact.js";
import { withStore, writeAtomic } from "../util/store.js";

export type Board = "linkedin" | "indeed";
export type Listing = { board: Board; id: string };
/** What a board's server said about one posting: the employer's link and how the posting takes applications. */
export type ResolvedListing = { url: string | null; applyType: string | null };

/**
 * Asks one board's server about one listing with the named tool and returns the text of its reply.
 * `timeoutMs` bounds the call; left out, the server's reading bound applies.
 */
export type ToolCall = (board: Board, tool: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<string>;
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
      // The LinkedIn server nests the employer's link under apply: {type, url}.
      const nested = (data as { apply?: { url?: unknown } }).apply?.url;
      const named = typeof nested === "string" ? linksIn(nested)[0] : undefined;
      if (named) return named;
    }
  } catch {
    /* not JSON: read it as text */
  }
  const links = linksIn(text);
  const known = links.find((l) => atsFromUrl(l) !== "other");
  if (known) return known;
  return links.find((l) => LOOKS_LIKE_APPLY.test(new URL(l).pathname + new URL(l).search)) ?? null;
}

/**
 * The same job at the employer's link. A job's id is derived from its link and is recomputed every
 * time the queue is read, so the id moves with the link: the record and the sheet row are keyed by it.
 */
export function withEmployerLink<T extends { id: string; url: string; ats: string }>(job: T, url: string): T {
  // The employer's own form is never the board's Easy Apply.
  return { ...job, id: jobId(url), url, ats: atsFromUrl(url), easyApply: false } as T;
}

const Apply = z.object({ apply: z.object({ type: z.string() }).nullish() });

/** How a posting takes applications, as its server's reply names it in `apply.type`, or null when it names none. */
export function applyTypeIn(text: string): string | null {
  try {
    const parsed = Apply.safeParse(JSON.parse(text));
    return parsed.success ? (parsed.data.apply?.type ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * What a board's apply type means for a job's easyApply field. Only the board's own two methods
 * answer the question; `applied` and `closed` no longer show one, so they keep what the source
 * already knew instead of guessing.
 */
export function easyApplyFromApplyType(type: string | null, current: boolean | null): boolean | null {
  if (type === "easy_apply") return true;
  if (type === "external") return false;
  return current;
}

const Cache = z.record(z.object({ url: z.string().nullable(), applyType: z.string().nullable().default(null), at: z.string() }));
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
export function mcpCaller(log: (line: string) => void = () => {}, session: SessionDirs = {}): Caller {
  const clients = new Map<Board, Promise<McpClient | null>>();
  let said = false;
  const clientFor = (board: Board) => {
    let p = clients.get(board);
    if (!p) {
      p = McpClient.start(MCP[board], { startupMs: MCP.startupMs, name: `the ${board} MCP server`, cwd: ROOT }).catch((err: unknown) => {
        log(`[links] ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      clients.set(board, p);
    }
    return p;
  };
  return {
    async call(board, tool, args, timeoutMs) {
      // The LinkedIn fork is only asked while its session can be used. A flag a run left, or a session
      // the fork has already rejected, means no call: a call would open a login window nobody is
      // watching and have the fork move the session aside again.
      if (board === "linkedin") {
        const gate = linkedinGate(session);
        if (!gate.ok) {
          if (!gate.flagged) markLoginRequired(gate.reason, session.dataDir);
          if (!said) log(`[links] LinkedIn is not asked: ${gate.reason}`);
          said = true;
          throw new NotAvailable(board, gate.reason);
        }
      }
      const client = await clientFor(board);
      if (!client) throw new NotAvailable(board);
      if (board !== "linkedin") return client.callTool(tool, args, timeoutMs ?? MCP.callMs);
      // A reply that says the fork needs a sign-in is not an answer about the posting: it sets the
      // flag so no later call is made, and it is never kept as "no link".
      let text: string;
      try {
        text = await client.callTool(tool, args, timeoutMs ?? MCP.callMs);
      } catch (err) {
        const notice = loginNoticeIn(err instanceof Error ? err.message : String(err));
        if (notice) {
          markLoginRequired(notice, session.dataDir);
          throw new NotAvailable(board, notice);
        }
        throw err;
      }
      const notice = loginNoticeIn(text);
      if (notice) {
        markLoginRequired(notice, session.dataDir);
        throw new NotAvailable(board, notice);
      }
      return text;
    },
    close() {
      for (const p of clients.values()) void p.then((c) => c?.close());
    },
  };
}

/** The board's server never started, so the call sent nothing. */
export class NotAvailable extends Error {
  constructor(readonly board: Board, reason?: string) {
    super(`the ${board} MCP server is not available${reason ? `: ${reason}` : ""}`);
    this.name = "NotAvailable";
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
 * Asks the boards' servers for the employer link and the apply type of each listing, at most `limit`
 * of them, and returns job id to what the server said for those it said anything about. An answer is
 * kept: a link for good, and "no link" for MCP.retryAfterHours. A server that fails is not an answer
 * and is not kept.
 */
export async function resolveListings(jobs: Pick<Job, "id" | "url">[], o: ResolveOptions): Promise<Map<string, ResolvedListing>> {
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const cache = loadListingLinks(o.cacheFile);
  const fresh: CacheFile = {};
  const found = new Map<string, ResolvedListing>();
  const down = new Set<Board>();
  let asked = 0;
  const limit = o.limit ?? MCP.maxPerRun;
  for (const job of jobs) {
    const listing = listingOf(job.url);
    if (!listing || down.has(listing.board)) continue;
    const key = `${listing.board}:${listing.id}`;
    const kept = cache[key];
    if (kept?.url) {
      found.set(job.id, { url: kept.url, applyType: kept.applyType });
      continue;
    }
    if (kept && now.getTime() - Date.parse(kept.at) < MCP.retryAfterHours * 3_600_000) {
      if (kept.applyType) found.set(job.id, { url: null, applyType: kept.applyType });
      continue;
    }
    if (asked >= limit) break;
    asked++;
    try {
      const args = listing.board === "linkedin" ? { job_id: listing.id } : { job_key: listing.id, country: MCP.indeedCountries[o.country] ?? o.country };
      const reply = await o.call(listing.board, MCP[listing.board].tools.read, args);
      const url = employerLinkIn(reply);
      const applyType = applyTypeIn(reply);
      fresh[key] = { url, applyType, at: now.toISOString() };
      if (url || applyType) {
        found.set(job.id, { url, applyType });
        if (url) log(`[links] ${listing.board} ${listing.id} -> ${safeUrl(url)}`);
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
