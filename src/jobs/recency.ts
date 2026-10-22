/**
 * The Last 12 hours rule, in one place. A job is recent while the tool first saw it less than
 * twelve hours ago and its posted date is not older than the same window. Boards give a date,
 * not a time, so the posted date is compared by calendar day in the machine's own time.
 */
import { HOURLY } from "../config.js";
import type { QueueEntry } from "./queue.js";

/** The machine's calendar date for a moment, as YYYY-MM-DD. */
export function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The moment twelve hours before `now`. */
export function recentCutoff(now = new Date()): Date {
  return new Date(now.getTime() - HOURLY.windowHours * 3_600_000);
}

/**
 * True while a job belongs on the Last 12 hours page. The first-seen time must be inside the
 * window, and a posted date, when there is one, must not be older than the window's first day.
 * A missing posted date does not disqualify the job: the hourly search only asks for jobs posted
 * in the last hour, so first-seen time stands in, and the page says the posted time is unknown.
 */
export function isRecent(e: Pick<QueueEntry, "discoveredAt" | "job">, now = new Date()): boolean {
  const seen = Date.parse(e.discoveredAt);
  if (!Number.isFinite(seen)) return false;
  const cutoff = recentCutoff(now);
  if (seen <= cutoff.getTime()) return false;
  if (!e.job.postedAt) return true;
  return e.job.postedAt >= localDate(cutoff);
}

/** The entries in `entries` that are recent, in the order they were given. */
export function recentEntries<T extends Pick<QueueEntry, "discoveredAt" | "job">>(entries: T[], now = new Date()): T[] {
  return entries.filter((e) => isRecent(e, now));
}

/**
 * Sorts recent entries first and keeps every other order as it was. Use it after `sortEntries`:
 * a fresh job jumps the score order while it is fresh, and falls back into it afterwards.
 */
export function recentFirst<T extends Pick<QueueEntry, "discoveredAt" | "job">>(entries: T[], now = new Date()): T[] {
  const recent = entries.filter((e) => isRecent(e, now));
  const rest = entries.filter((e) => !isRecent(e, now));
  return [...recent, ...rest];
}

/**
 * Moves a held job to the person once its window is over. A held job is one the tool cannot fill
 * (an Indeed or LinkedIn listing) that the hourly search put in the queue so the page could show
 * it. Only a queued held job is touched: a status a person chose, a job a run owns, and anything
 * already settled are left alone. Returns the entries it changed, for the record.
 */
export function ageHeldEntries(q: { entries: QueueEntry[] }, now = new Date()): QueueEntry[] {
  const changed: QueueEntry[] = [];
  for (const e of q.entries) {
    // holdUntil is the mark the hourly run put there. A person changing the status clears it,
    // so a choice they made by hand is never undone by a later sweep.
    if (e.status !== "queued" || e.applyable !== false || !e.holdUntil || isRecent(e, now)) continue;
    e.status = "needs_review";
    e.statusReason = HOURLY.staleReason;
    e.waitingFor = null;
    e.holdUntil = null;
    e.updatedAt = now.toISOString();
    changed.push(e);
  }
  return changed;
}
