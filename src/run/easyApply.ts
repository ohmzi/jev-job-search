/**
 * The Easy Apply step of an hourly run. It asks the local LinkedIn fork for postings this portal's
 * profile wants, reads each result, keeps the ones that take Easy Apply and were posted in the last
 * twelve hours, and sends them through the fork. Every reply is data: it is parsed and never run,
 * and a sign of a bot check stops the whole step rather than pressing on.
 *
 * The search asks LinkedIn for the last day because its filter has no twelve-hour option. The age
 * is read from the posting itself and checked in code, so an older posting is skipped even though
 * the board returned it.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { HOURLY, MCP, PATHS } from "../config.js";
import { jobId } from "../jobs/normalize.js";
import { loadQueue } from "../jobs/queue.js";
import { recordMcpApplication } from "../jobs/recordMcp.js";
import { loadRows, parseCsv } from "../log/csv.js";
import type { Profile } from "../profile/schema.js";
import { applyOnLinkedIn } from "../sources/linkedinApply.js";
import { applyTypeIn, mcpCaller, type Caller, type ToolCall } from "../sources/listingLink.js";
import { countToday, localDay } from "./daily.js";
import type { Policy } from "./policy.js";

/** The read tool that returns a posting's own text, including its place, age and applicant count. */
const DETAILS_TOOL = "get_job_details";

export type EasyApplyOptions = {
  dry?: boolean;
  policy: Policy;
  count?: number;
  log?: (line: string) => void;
  call?: ToolCall;
  close?: () => void;
  now?: Date;
  /** Injected in tests so pacing is checked without waiting. */
  sleep?: (ms: number) => Promise<void>;
  files?: { queue?: string; rows?: string };
};

export type EasyApplySummary = {
  found: number;
  scanned: number;
  applied: { company: string; title: string; url: string }[];
  /** Postings read but left alone: blocked, failed, or a call that did not answer. */
  left: number;
  /** Postings skipped because their posted date is older than the window, or cannot be read. */
  tooOld: number;
  reason: string | null;
  stopped: string | null;
};

const SearchReply = z.object({ job_ids: z.array(z.string()).default([]) });
const ReadReply = z.object({ url: z.string().optional() });
const DetailsReply = z.object({ sections: z.record(z.string()).optional() });

type PostingDetails = { company: string; title: string; location: string; ageHours: number | null; ageText: string | null };

const linkedinUrl = (id: string) => `https://www.linkedin.com/jobs/view/${id}`;

/** The empty answer when the step never gets as far as the board. */
const empty = (): EasyApplySummary => ({ found: 0, scanned: 0, applied: [], left: 0, tooOld: 0, reason: null, stopped: null });

/** The text that says a board is asking whether a person is there, or has had enough for now. */
const CHALLENGE = /captcha|challenge|rate[\s-]?limit|unusual activity|verify you|security check/i;

/**
 * How old a posting is, in hours, from the segment of its own line that says so. "Just now" is
 * zero; minutes and hours are exact; days, weeks and months are all older than the hourly window.
 * Null when the segment is not an age at all.
 */
export function ageHoursOf(segment: string): number | null {
  const text = segment.trim().replace(/^posted\s+/i, "");
  if (/^just now$/i.test(text)) return 0;
  const m = /^(\d+)\+?\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] as string).toLowerCase()) {
    case "minute": return n / 60;
    case "hour": return n;
    case "day": return n * 24;
    case "week": return n * 24 * 7;
    default: return n * 24 * 30;
  }
}

/**
 * The company, title, place and age at the top of a posting's own text. The first two lines are
 * the company and the title; the next is the place, the age and the applicant count, separated by
 * a middle dot. Null when the reply carries no posting text this module can read.
 */
export function postingDetailsIn(text: string): PostingDetails | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = DetailsReply.safeParse(json);
  if (!parsed.success) return null;
  const posting = parsed.data.sections?.job_posting;
  if (!posting) return null;
  const lines = posting.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const company = lines[0] ?? "";
  const title = lines[1] ?? "";
  const parts = (lines[2] ?? "").split("·").map((part) => part.trim()).filter(Boolean);
  let location = "";
  if (parts.length) {
    const first = parts[0] as string;
    if (/^location[:\s]*$/i.test(first) && parts.length > 1) {
      location = parts[1] as string;
      parts.splice(0, 2);
    } else {
      location = first.replace(/^location[:\s]+/i, "").trim();
      parts.shift();
    }
  }
  let ageHours: number | null = null;
  let ageText: string | null = null;
  for (const part of parts) {
    const hours = ageHoursOf(part);
    if (hours !== null) {
      ageHours = hours;
      ageText = part.replace(/^posted\s+/i, "");
      break;
    }
  }
  return { company, title, location, ageHours, ageText };
}

/** The link the read tool gave for the posting, when it is LinkedIn's own; otherwise the usual one. */
function readUrlIn(text: string, id: string): string {
  try {
    const parsed = ReadReply.safeParse(JSON.parse(text));
    const url = parsed.success ? parsed.data.url : undefined;
    if (url && /(^|\.)linkedin\.com$/i.test(new URL(url).hostname)) return url;
  } catch {
    /* the usual link below */
  }
  return linkedinUrl(id);
}

/**
 * What the record files already say was sent. The full file holds every application and is where
 * applied.csv is rebuilt from; the plain file is read too when the real records are in use, in
 * case another command wrote it since the full one was read.
 */
function sentAlready(rowsFile?: string): Set<string> {
  const out = new Set<string>();
  const add = (link: string, id: string) => {
    if (link) out.add(link);
    if (id) out.add(id);
  };
  for (const row of loadRows(rowsFile ?? PATHS.applications)) {
    if (row["App. Status"].startsWith("Applied")) add(row["Job Link"], row["Job ID"]);
  }
  if (rowsFile === undefined && existsSync(PATHS.applied)) {
    try {
      const [header = [], ...body] = parseCsv(readFileSync(PATHS.applied, "utf8"));
      const linkCol = header.indexOf("job_link");
      const idCol = header.indexOf("job_id");
      for (const cells of body) add(cells[linkCol] ?? "", cells[idCol] ?? "");
    } catch {
      /* an unreadable sent list leaves the queue as the record of what was sent */
    }
  }
  return out;
}

/**
 * Runs the Easy Apply step. Every reply is parsed as JSON; anything else is no answer. A posting
 * is applied to only when it takes Easy Apply, its age is inside the window, and nothing on the
 * board already records it as sent. The first bot check stops the step.
 */
export async function applyEasyApply(profile: Profile, o: EasyApplyOptions): Promise<EasyApplySummary> {
  const cfg = HOURLY.easyApply;
  const log = o.log ?? (() => {});
  const summary = empty();
  if (!cfg.enabled) {
    summary.reason = "the easy apply step is off";
    return summary;
  }
  const search = profile.search;
  const keywords = search?.terms[0];
  const location = search?.locations[0]?.query;
  if (!keywords || !location) {
    summary.reason = "the profile has no search term or place for the easy apply step";
    return summary;
  }

  const caller: Caller = o.call ? { call: o.call, close: o.close ?? (() => {}) } : mcpCaller(log);
  const clockStart = o.now ?? new Date();
  // A run's clock only moves when it sleeps, so a test that injects a no-op sleep sees the pacing
  // without waiting. A real run sleeps for real.
  let clock = clockStart.getTime();
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastRead = Number.NEGATIVE_INFINITY;
  let lastSubmit = Number.NEGATIVE_INFINITY;
  /** Waits until `gap` has passed since `last`, and moves the run's clock with the wait. */
  const pace = async (last: number, gap: number) => {
    const wait = last + gap - clock;
    if (wait <= 0) return;
    await sleep(wait);
    clock += wait;
  };
  const read = async (tool: string, args: Record<string, unknown>, timeoutMs?: number) => {
    await pace(lastRead, cfg.readGapMs);
    const text = await caller.call("linkedin", tool, args, timeoutMs);
    lastRead = clock;
    return text;
  };
  const stopOnChallenge = (text: string): boolean => {
    const hit = CHALLENGE.exec(text);
    if (!hit) return false;
    summary.stopped = text.trim();
    log(`[easy] the step stopped: ${hit[0]}`);
    return true;
  };

  try {
    let searchText: string;
    try {
      searchText = await read(MCP.linkedin.tools.search, { keywords, location, easy_apply: true, date_posted: cfg.datePosted, max_pages: cfg.pages });
    } catch (err) {
      summary.reason = `the linkedin search tool did not answer: ${err instanceof Error ? err.message : String(err)}`;
      return summary;
    }
    if (stopOnChallenge(searchText)) return summary;
    let ids: string[];
    try {
      ids = [...new Set(SearchReply.parse(JSON.parse(searchText)).job_ids.map((id) => id.trim()).filter(Boolean))];
    } catch {
      summary.reason = "the linkedin search tool answered in a shape this tool does not read";
      return summary;
    }
    summary.found = ids.length;

    const queue = loadQueue(o.files?.queue ?? PATHS.queue);
    const day = countToday(queue.entries, localDay(new Date(clock)));
    const already = new Set<string>(sentAlready(o.files?.rows));
    for (const entry of queue.entries) {
      if (entry.status !== "applied") continue;
      already.add(entry.job.url);
      already.add(entry.job.id);
    }
    const cap = Math.min(o.count ?? cfg.count, Math.max(0, o.policy.target - day.sent));
    if (cap <= 0) {
      summary.reason = `the day's target of ${o.policy.target} applications is reached (${day.sent} sent)`;
      return summary;
    }

    let applied = 0;
    for (const id of ids.slice(0, cfg.scan)) {
      if (applied >= cap) break;
      const baseUrl = linkedinUrl(id);
      const baseId = jobId(baseUrl);
      if (already.has(baseUrl) || already.has(baseId)) {
        log(`[easy] ${id} skipped: already applied`);
        continue;
      }

      let readText: string;
      try {
        readText = await read(MCP.linkedin.tools.read, { job_id: id });
      } catch (err) {
        log(`[easy] ${id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      summary.scanned++;
      if (stopOnChallenge(readText)) return summary;
      if (applyTypeIn(readText) !== "easy_apply") continue;
      if (o.dry) break;

      // The age has to be read before the application is sent, so a posting outside the window
      // never reaches the fork's submit control.
      let detailsText: string;
      try {
        detailsText = await read(DETAILS_TOOL, { job_id: id });
      } catch (err) {
        summary.tooOld++;
        log(`[easy] ${id} skipped: its posted date could not be read (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (stopOnChallenge(detailsText)) return summary;
      const details = postingDetailsIn(detailsText);
      const label = details ? [details.company, details.title].filter(Boolean).join(" - ") || id : id;
      if (!details || details.ageHours === null) {
        summary.tooOld++;
        log(`[easy] ${label} skipped: its posted date could not be read`);
        continue;
      }
      if (details.ageHours > cfg.maxAgeHours) {
        summary.tooOld++;
        log(`[easy] ${label} skipped: posted ${details.ageText ?? "too long ago"}`);
        continue;
      }

      const url = readUrlIn(readText, id);
      await pace(lastSubmit, cfg.gapMs);
      try {
        lastSubmit = clock;
        const result = await applyOnLinkedIn(id, { call: caller.call, callMs: MCP.applyCallMs });
        if (stopOnChallenge(result.message)) return summary;
        if (result.status === "applied" || result.status === "already_applied") {
          summary.applied.push({ company: details.company, title: details.title, url });
          if (!o.dry) {
            recordMcpApplication(
              { jobId: id, company: details.company, title: details.title, location: details.location, url, appliedAt: new Date(clock).toISOString(), source: "linkedin easy apply (mcp)" },
              o.files,
            );
          }
          already.add(url);
          already.add(jobId(url));
          applied++;
        } else if (result.status === "blocked" || result.status === "failed") {
          summary.left++;
          log(`[easy] ${[details.company, details.title].filter(Boolean).join(" - ") || id} ${result.status}: ${result.message}`);
        } else {
          log(`[easy] ${[details.company, details.title].filter(Boolean).join(" - ") || id} ${result.status}: ${result.message}`);
        }
      } catch (err) {
        summary.left++;
        log(`[easy] ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return summary;
  } finally {
    caller.close();
  }
}
