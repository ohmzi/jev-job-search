/**
 * The Last 12 hours page's rows. Every entry the tool first saw inside the window, newest first,
 * whatever its status, so a find the search refused is still visible with its reason.
 */
import { isRecent } from "../jobs/recency.js";
import type { QueueEntry } from "../jobs/queue.js";
import { STATUS_WORDS } from "../log/csv.js";

export type RecentRow = {
  id: string;
  company: string;
  title: string;
  link: string;
  location: string;
  board: string;
  /** The posted date in YYYY-MM-DD, empty when the board gave none. */
  posted_on: string;
  /** The exact posted time when the board gave one, empty otherwise. */
  posted_at: string;
  /** When the tool first saw the job. */
  found_at: string;
  age_hours: number;
  fit_score: number | null;
  status: string;
  status_key: string;
  applyable: boolean;
  /** Why the job is on the page, or why it will not be applied to. */
  why: string;
};

/** Why this row is worth the person's attention, in one short phrase. */
export function whyShown(e: QueueEntry): string {
  if (e.status === "applied") return "already sent";
  if (e.status === "submission_unknown") return "sent, not confirmed";
  if (e.applyable === false) {
    return e.status === "needs_review" ? "yours to apply on the site" : "the tool cannot fill this board; yours at 12 hours";
  }
  const reason = e.statusReason ?? e.preFilterReason;
  if (reason && (e.status === "skipped" || e.status === "failed" || e.fit?.decision === "below_threshold")) return reason;
  if (!e.job.postedAt) return "posted time unknown";
  if (e.fit?.decision === "below_threshold") return "below the fit threshold";
  return "new find";
}

/** The rows, newest find first; ties go to the newest posting, then the highest fit. */
export function buildRecent(entries: QueueEntry[], now = new Date()): RecentRow[] {
  // A job that has been applied to, or may already be with the employer, is not a posting to
  // consider again: once it leaves this list it never comes back.
  const rows: RecentRow[] = entries
    .filter((e) => isRecent(e, now) && e.status !== "applied" && e.status !== "submission_unknown")
    .map((e) => {
    const seen = Date.parse(e.discoveredAt);
    return {
      id: e.job.id,
      company: e.job.company,
      title: e.job.title,
      link: e.job.url,
      location: e.job.locations.join(" / "),
      board: e.job.ats === "other" ? e.job.source : e.job.ats,
      posted_on: e.job.postedAt ?? "",
      posted_at: e.job.postedAtExact ?? "",
      found_at: e.discoveredAt,
      age_hours: Number.isFinite(seen) ? Math.max(0, Math.floor((now.getTime() - seen) / 3_600_000)) : 0,
      fit_score: e.fit?.score ?? null,
      status: STATUS_WORDS[e.status],
      status_key: e.status,
      applyable: e.applyable !== false,
      why: whyShown(e),
    };
  });
  return rows.sort(
    (a, b) =>
      b.found_at.localeCompare(a.found_at) ||
      b.posted_at.localeCompare(a.posted_at) ||
      (b.fit_score ?? -1) - (a.fit_score ?? -1) ||
      a.company.localeCompare(b.company),
  );
}
