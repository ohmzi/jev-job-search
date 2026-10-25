/**
 * The Easy Apply step of an hourly run. It asks the local LinkedIn fork for postings this portal's
 * profile wants, reads each result, keeps the ones that take Easy Apply and were posted in the last
 * twelve hours, and sends them through the fork. Every reply is data: it is parsed and never run,
 * and a board notice that asks whether a person is there stops the whole step rather than pressing
 * on.
 *
 * The search asks LinkedIn for the last day because its filter has no twelve-hour option. The age
 * is read from the posting itself and checked in code, so an older posting is skipped even though
 * the board returned it.
 *
 * An application is written to the queue as unconfirmed before the fork is asked to send it, and
 * only promoted to applied on a clean reply. An unreadable reply, a timeout or an unknown outcome
 * is therefore never sent again by a later run.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { HOURLY, MCP, PATHS } from "../config.js";
import { appliedKey } from "../jobs/keys.js";
import { jobId } from "../jobs/normalize.js";
import { loadQueue, MAYBE_SENT } from "../jobs/queue.js";
import { recordMcpApplication, recordMcpOutcome, recordMcpSubmission, type McpRecord } from "../jobs/recordMcp.js";
import { loadRows, parseCsv } from "../log/csv.js";
import type { Profile } from "../profile/schema.js";
import { applyOnLinkedIn } from "../sources/linkedinApply.js";
import { applyTypeIn, mcpCaller, type Caller, type ToolCall } from "../sources/listingLink.js";
import { countToday, localDay } from "./daily.js";
import { clearLoginRequired, markLoginRequired, restoreSessionIfMissing, sessionStatus } from "./linkedinSession.js";
import type { Policy } from "./policy.js";
import { recordSharedApplied, sharedAppliedKeys } from "./shared.js";

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
  /** Where the fork keeps its session and where the login flag goes. Injected in tests. */
  session?: { authRoot?: string; backupRoot?: string; dataDir?: string };
};

export type EasyApplySummary = {
  found: number;
  scanned: number;
  applied: { company: string; title: string; url: string }[];
  /** Postings read but left alone: blocked, failed, or a call that did not answer. */
  left: number;
  /** Postings whose read said they do not take Easy Apply. */
  notEasyApply: number;
  /** Postings skipped because their posted date is older than the window, or cannot be read. */
  tooOld: number;
  reason: string | null;
  stopped: string | null;
};

const SearchReply = z.object({ job_ids: z.array(z.string()).default([]) });
const ErrorReply = z
  .object({
    section_errors: z.record(z.unknown()).optional(),
    error_type: z.string().optional(),
    error_message: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
const SectionError = z.object({ error_type: z.string().optional(), error_message: z.string().optional(), message: z.string().optional() }).passthrough();
const DetailsReply = z.object({ sections: z.record(z.unknown()).optional() });

type PostingDetails = { company: string; title: string; location: string; ageHours: number | null; ageText: string | null };

const linkedinUrl = (id: string) => `https://www.linkedin.com/jobs/view/${id}`;

/** The empty answer when the step never gets as far as the board. */
const empty = (): EasyApplySummary => ({ found: 0, scanned: 0, applied: [], left: 0, notEasyApply: 0, tooOld: 0, reason: null, stopped: null });

/**
 * A board notice that asks whether a person is there, or says the board has had enough for now.
 * Only notice fields are matched, never a posting's own text: a job description that talks about
 * challenges or rate limiting must not stop a run.
 */
const NOTICE = /captcha|unusual activity|security check|rate[\s-]?limit(?:ed|ing)?|verify you are human/i;

/** The token in a string that reads as a board notice, or null. */
export function noticeIn(text: string | undefined | null): string | null {
  if (!text) return null;
  const hit = NOTICE.exec(text);
  return hit ? hit[0] : null;
}

/**
 * The fork's own words when it needs a person to sign in. Only an error field is read: a posting's
 * description may say "sign in" as ordinary prose and must not stop a run.
 */
const LOGIN_NOTICE = /login window|login required|authentication started|sign in/i;

export function loginNoticeIn(text: string | undefined | null): string | null {
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const hit = LOGIN_NOTICE.exec(text);
    return hit ? hit[0] : null;
  }
  if (!json || typeof json !== "object") return null;
  const fields: (string | undefined)[] = [];
  const parsed = ErrorReply.safeParse(json);
  if (parsed.success) {
    fields.push(parsed.data.error_type, parsed.data.error_message, parsed.data.message);
    for (const value of Object.values(parsed.data.section_errors ?? {})) {
      const error = SectionError.safeParse(value);
      if (error.success) fields.push(error.data.error_type, error.data.error_message, error.data.message);
    }
  }
  // Only top-level error words are read, never a posting's own text under `sections`.
  const object = json as Record<string, unknown>;
  for (const key of ["error", "error_type", "error_message", "message", "detail", "reason"]) {
    const value = object[key];
    if (typeof value === "string") fields.push(value);
  }
  for (const field of fields) {
    if (!field) continue;
    const hit = LOGIN_NOTICE.exec(field);
    if (hit) return hit[0];
  }
  return null;
}

/**
 * A challenge in a reply's error fields, or null. Sections are never read: `get_job_details`
 * carries the whole posting there, and an ordinary description must not look like a wall. The
 * fork's structured `error_type: "rate_limit"` counts even when its message says nothing.
 */
export function challengeIn(text: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ErrorReply.safeParse(json);
  if (!parsed.success) return null;
  for (const value of Object.values(parsed.data.section_errors ?? {})) {
    const error = SectionError.safeParse(value);
    if (!error.success) continue;
    const type = error.data.error_type ?? "";
    if (/^(?:rate_limit|captcha)$/i.test(type)) return type;
    const notice = noticeIn(error.data.error_message ?? error.data.message);
    if (notice) return notice;
  }
  return noticeIn(parsed.data.error_type) ?? noticeIn(parsed.data.error_message) ?? noticeIn(parsed.data.message);
}

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
 * The company, title, place and age at the top of a posting's own text. The first two non-empty
 * lines are the company then the title, the live layout. The age is looked for on the first
 * several lines, because it sometimes sits on the place's line and sometimes on one of its own,
 * and the place is the segment just before it. Null when the reply carries no posting text this
 * module can read.
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
  if (typeof posting !== "string") return null;
  const lines = posting.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const company = lines[0] ?? "";
  const title = lines[1] ?? "";
  let location = "";
  let ageHours: number | null = null;
  let ageText: string | null = null;
  const last = Math.min(lines.length, 12);
  for (let i = 0; i < last && ageHours === null; i++) {
    const parts = (lines[i] as string).split("·").map((part) => part.trim()).filter(Boolean);
    for (let j = 0; j < parts.length; j++) {
      const segment = parts[j] as string;
      const hours = ageHoursOf(segment);
      if (hours === null) continue;
      ageHours = hours;
      ageText = segment.replace(/^posted\s+/i, "");
      let before = parts[j - 1];
      if (before && /^location[:\s]*$/i.test(before) && j >= 2) before = parts[j - 2];
      if (before) location = before.replace(/^location[:\s]+/i, "").trim();
      else if (i > 0) location = (lines[i - 1] as string).replace(/^location[:\s]+/i, "").trim();
      break;
    }
  }
  return { company, title, location, ageHours, ageText };
}

/**
 * What the record files already say was sent, or may have been. The full file holds every
 * application and is where applied.csv is rebuilt from; the plain file is read too when the real
 * records are in use, in case another command wrote it since the full one was read.
 */
function sentAlready(rowsFile?: string): Set<string> {
  const out = new Set<string>();
  const add = (link: string, id: string) => {
    if (link) out.add(link);
    if (id) out.add(id);
  };
  // "Unconfirmed" is a send whose confirmation never came. It is treated as sent, never repeated.
  const sent = (status: string) => status.startsWith("Applied") || status.startsWith("Unconfirmed");
  let rows: ReturnType<typeof loadRows> = [];
  try {
    rows = loadRows(rowsFile ?? PATHS.applications);
  } catch {
    /* an unreadable record leaves the queue as the record of what was sent */
  }
  for (const row of rows) {
    if (sent(row["App. Status"])) add(row["Job Link"], row["Job ID"]);
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
 * is applied to only when it takes Easy Apply, its age is inside the window, nothing on the board
 * records it as sent, and no portal has sent it already. The first board notice stops the step.
 * The caller holds the cross-portal apply lock.
 */
export async function applyEasyApply(profile: Profile, o: EasyApplyOptions): Promise<EasyApplySummary> {
  const cfg = HOURLY.easyApply;
  const log = o.log ?? (() => {});
  const summary = empty();
  if (!cfg.enabled) {
    summary.reason = "the easy apply step is off";
    return summary;
  }
  const session = o.session ?? {};
  let loginFlagged = false;
  const requireLogin = (notice: string) => {
    loginFlagged = true;
    markLoginRequired(notice, session.dataDir);
    summary.reason = `LinkedIn login required: ${notice}`;
    log(`[easy] ${summary.reason}`);
    return summary;
  };
  // A session the fork cannot use is the person's to renew. Asking the MCP anyway opens a login
  // window nobody is watching and quarantines the auth state, so the step stops before it calls.
  restoreSessionIfMissing(session.authRoot, session.backupRoot);
  const state = sessionStatus(session.authRoot);
  if (!state.ok) return requireLogin(state.reason ?? "the saved session is not usable");
  const search = profile.search;
  const keywords = search?.terms[0];
  const location = search?.locations[0]?.query;
  if (!keywords || !location) {
    summary.reason = "the profile has no search term or place for the easy apply step";
    return summary;
  }
  const portal = search?.portal ?? "portal";

  const caller: Caller = o.call ? { call: o.call, close: o.close ?? (() => {}) } : mcpCaller(log);
  const clockStart = o.now ?? new Date();
  // The pacing clock only moves when the run sleeps, so a test that injects a no-op sleep sees the
  // pacing without waiting. Recorded times use the real clock, never this one.
  let clock = clockStart.getTime();
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastRead = Number.NEGATIVE_INFINITY;
  let lastSubmit = Number.NEGATIVE_INFINITY;
  /** Waits until `gap` has passed since `last`, and moves the pacing clock with the wait. */
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

  try {
    let searchText: string;
    try {
      searchText = await read(MCP.linkedin.tools.search, { keywords, location, easy_apply: true, date_posted: cfg.datePosted, max_pages: cfg.pages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const login = loginNoticeIn(message);
      if (login) return requireLogin(login);
      summary.reason = `the linkedin search tool did not answer: ${message}`;
      return summary;
    }
    const searchLogin = loginNoticeIn(searchText);
    if (searchLogin) return requireLogin(searchLogin);
    const searchNotice = challengeIn(searchText);
    if (searchNotice) {
      summary.stopped = searchNotice;
      log(`[easy] the step stopped: ${searchNotice}`);
      return summary;
    }
    let ids: string[];
    try {
      ids = [...new Set(SearchReply.parse(JSON.parse(searchText)).job_ids.map((id) => id.trim()).filter(Boolean))];
    } catch {
      summary.reason = "the linkedin search tool answered in a shape this tool does not read";
      return summary;
    }
    summary.found = ids.length;

    const queue = loadQueue(o.files?.queue ?? PATHS.queue);
    const day = countToday(queue.entries, localDay(o.now ?? clockStart));
    const shared = sharedAppliedKeys();
    const already = sentAlready(o.files?.rows);
    // A send that was never confirmed still occupies the posting: it is never sent a second time.
    for (const entry of queue.entries) {
      if (!MAYBE_SENT.includes(entry.status)) continue;
      already.add(entry.job.url);
      already.add(entry.job.id);
    }
    const cap = Math.min(o.count ?? cfg.count, Math.max(0, o.policy.target - day.sent));
    if (cap <= 0) {
      summary.reason = `the day's target of ${o.policy.target} applications is reached (${day.sent} sent)`;
      return summary;
    }

    let applied = 0;
    let wouldApply = 0;
    for (const id of ids.slice(0, cfg.scan)) {
      if (applied >= cap) break;
      if (o.dry && wouldApply >= cap) break;
      const url = linkedinUrl(id);
      const recordId = jobId(url);
      if (already.has(url) || already.has(recordId)) {
        log(`[easy] ${id} skipped: already applied`);
        continue;
      }

      let readText: string;
      try {
        readText = await read(MCP.linkedin.tools.read, { job_id: id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const login = loginNoticeIn(message);
        if (login) return requireLogin(login);
        log(`[easy] ${id}: ${message}`);
        continue;
      }
      summary.scanned++;
      const readLogin = loginNoticeIn(readText);
      if (readLogin) return requireLogin(readLogin);
      const readNotice = challengeIn(readText);
      if (readNotice) {
        summary.stopped = readNotice;
        log(`[easy] the step stopped: ${readNotice}`);
        return summary;
      }
      const applyType = applyTypeIn(readText);
      if (applyType !== "easy_apply") {
        summary.notEasyApply++;
        log(`[easy] ${id} skipped: not easy apply (${applyType ?? "unknown"})`);
        continue;
      }

      // The details are read before anything is sent: the age has to be checked, and the company
      // and title are what the record needs. They are reused for the recording, never read twice.
      let detailsText: string;
      try {
        detailsText = await read(MCP.linkedin.tools.details, { job_id: id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const login = loginNoticeIn(message);
        if (login) return requireLogin(login);
        summary.tooOld++;
        log(`[easy] ${id} skipped: its posted date could not be read (${message})`);
        continue;
      }
      const detailsLogin = loginNoticeIn(detailsText);
      if (detailsLogin) return requireLogin(detailsLogin);
      const detailsNotice = challengeIn(detailsText);
      if (detailsNotice) {
        summary.stopped = detailsNotice;
        log(`[easy] the step stopped: ${detailsNotice}`);
        return summary;
      }
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
      const key = appliedKey({ company: details.company, title: details.title });
      if (shared.has(key)) {
        already.add(url);
        already.add(recordId);
        log(`[easy] ${label} skipped: another portal already applied`);
        continue;
      }
      if (o.dry) {
        wouldApply++;
        log(`[easy] would apply: ${label} (${details.ageText ?? "just now"})`);
        continue;
      }

      const recordInput = { jobId: id, company: details.company, title: details.title, location: details.location, url, source: "linkedin easy apply (mcp)" };
      // The unconfirmed record goes in before the fork is asked to send. If it cannot be written,
      // nothing is sent: the next run would otherwise have no way to know an application may exist.
      let attempt: McpRecord;
      try {
        attempt = recordMcpSubmission({ ...recordInput, appliedAt: null }, o.files, log);
      } catch (err) {
        summary.reason = `the queue could not record the send, so the step stopped before sending: ${err instanceof Error ? err.message : String(err)}`;
        log(`[easy] ${summary.reason}`);
        return summary;
      }
      if (!attempt.rowsWritten) {
        summary.reason = "the sheet could not be written, so the step stopped before sending; reconcile the record queue and sheet";
        log(`[easy] ${summary.reason}`);
        return summary;
      }

      await pace(lastSubmit, cfg.gapMs);
      lastSubmit = clock;
      let status: string;
      let message: string;
      try {
        const result = await applyOnLinkedIn(id, { call: caller.call, callMs: MCP.applyCallMs });
        status = result.status;
        message = result.message;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const login = loginNoticeIn(reason);
        if (login) return requireLogin(login);
        summary.left++;
        log(`[easy] ${label} left unconfirmed: ${reason}`);
        continue;
      }
      const applyLogin = loginNoticeIn(message);
      if (applyLogin) return requireLogin(applyLogin);
      const applyNotice = noticeIn(message);
      if (applyNotice) {
        summary.stopped = applyNotice;
        log(`[easy] the step stopped: ${applyNotice}`);
        return summary;
      }
      if (status === "applied") {
        // Counting the send and writing it are separate: a failed write must not make the run send
        // more than its cap while recording none of them.
        applied++;
        summary.applied.push({ company: details.company, title: details.title, url });
        const appliedAt = new Date().toISOString();
        shared.add(key);
        already.add(url);
        already.add(recordId);
        // The shared list goes in before the local record, so a local write failure cannot leave
        // another portal free to send the same posting.
        try {
          recordSharedApplied([{ id: recordId, company: details.company, title: details.title, url, appliedAt }], portal);
        } catch (err) {
          log(`[easy] the shared applied list could not be written: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          const written = recordMcpApplication({ ...recordInput, appliedAt }, o.files, log);
          if (!written.rowsWritten) {
            summary.reason = "the application was recorded in the queue but the sheet could not be written; reconcile them";
            log(`[easy] ${summary.reason}`);
            return summary;
          }
        } catch (err) {
          summary.reason = `the application was sent but could not be recorded: ${err instanceof Error ? err.message : String(err)}`;
          log(`[easy] ${summary.reason}`);
          return summary;
        }
      } else if (status === "already_applied") {
        // The time it was sent is unknown, so it is recorded without one and does not count
        // against today's target. It still stops this or any other portal sending it again.
        shared.add(key);
        already.add(url);
        already.add(recordId);
        try {
          recordSharedApplied([{ id: recordId, company: details.company, title: details.title, url }], portal);
        } catch (err) {
          log(`[easy] the shared applied list could not be written: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          const written = recordMcpApplication({ ...recordInput, appliedAt: null }, o.files, log);
          if (!written.rowsWritten) {
            summary.reason = "the application was recorded in the queue but the sheet could not be written; reconcile them";
            log(`[easy] ${summary.reason}`);
            return summary;
          }
        } catch (err) {
          summary.reason = `linkedin said the posting was already applied to but it could not be recorded: ${err instanceof Error ? err.message : String(err)}`;
          log(`[easy] ${summary.reason}`);
          return summary;
        }
        log(`[easy] ${label} was already applied on linkedin`);
      } else if (status === "closed") {
        try {
          const written = recordMcpOutcome({ ...recordInput, appliedAt: null }, "skipped", "the posting is closed", o.files, log);
          if (!written.rowsWritten) {
            summary.reason = "the posting was recorded in the queue but the sheet could not be written; reconcile them";
            log(`[easy] ${summary.reason}`);
            return summary;
          }
        } catch (err) {
          summary.reason = `the closed posting could not be recorded: ${err instanceof Error ? err.message : String(err)}`;
          log(`[easy] ${summary.reason}`);
          return summary;
        }
        log(`[easy] ${label} skipped: the posting is closed`);
      } else if (status === "blocked" || status === "failed" || status === "not_easy_apply" || status === "external") {
        // The fork returns these before its submit control is clicked, so nothing was sent. The
        // pre-send record is replaced by needs_review, which a later run may take again.
        summary.left++;
        try {
          const written = recordMcpOutcome({ ...recordInput, appliedAt: null }, "needs_review", message, o.files, log);
          if (!written.rowsWritten) {
            summary.reason = "the posting was recorded in the queue but the sheet could not be written; reconcile them";
            log(`[easy] ${summary.reason}`);
            return summary;
          }
        } catch (err) {
          summary.reason = `the unsent posting could not be recorded: ${err instanceof Error ? err.message : String(err)}`;
          log(`[easy] ${summary.reason}`);
          return summary;
        }
        log(`[easy] ${label} ${status}: ${message}`);
      } else {
        // outcome_unknown may have been sent: the entry stays unconfirmed.
        log(`[easy] ${label} ${status}: ${message}`);
      }
    }
    // A run that read results but applied to none says why, so the hourly line is never silent.
    if (summary.applied.length === 0 && summary.reason === null && summary.stopped === null && !o.dry) {
      summary.reason =
        summary.found > 0 && summary.notEasyApply === summary.found
          ? "no posting in the results was an Easy Apply posting"
          : "no posting in the results was applied to";
    }
    return summary;
  } finally {
    // The fork answered a real search or sent something: the session is good, so a stale flag goes.
    // A run that just found the login error keeps its flag.
    if (!loginFlagged && (summary.found > 0 || summary.applied.length > 0)) clearLoginRequired(session.dataDir);
    caller.close();
  }
}
