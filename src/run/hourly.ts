/**
 * One hourly search. It ages held jobs, asks the boards for jobs posted in the last hour, and
 * writes the new finds into the queue. No browser, no form, no sign-in, no mail, no send.
 *
 * A find the tool can fill is queued for an apply run. A board-only listing is held for the
 * person and becomes needs_review when its twelve hours are over. Neither is rated with DeepSeek:
 * the hourly run is about being first, and the place it holds in the apply order comes from how
 * fresh it is, not from a score.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { capabilityFor } from "../accounts/capability.js";
import { DISCOVER, HOURLY, PATHS } from "../config.js";
import { canFill } from "../jobs/fillable.js";
import { preFilter } from "../jobs/hardFilters.js";
import { isWalled } from "../jobs/walled.js";
import { ageHeldEntries, isRecent } from "../jobs/recency.js";
import type { Job } from "../jobs/normalize.js";
import { loadQueue, mutateQueue, type QueueEntry } from "../jobs/queue.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import { usStatus, type Profile, type Search } from "../profile/schema.js";
import { searchJobspy, type JobspyRunner } from "../sources/jobspy.js";
import { withStore, writeAtomic } from "../util/store.js";

const keyPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The same posting from two boards, in the words the person would compare them by. */
export function hourlyKey(j: Pick<Job, "company" | "title" | "locations">): string {
  return `${keyPart(j.company)}|${keyPart(j.title)}|${keyPart(j.locations.join(","))}`;
}

/**
 * The looser key an applied job is remembered by. A board can move the same role to another
 * location or another link; the employer and title are what say it is the job that was sent.
 */
export function appliedKey(j: Pick<Job, "company" | "title">): string {
  return `${keyPart(j.company)}|${keyPart(j.title)}`;
}

export type HourlySummary = {
  found: number;
  added: number;
  updated: number;
  held: number;
  skipped: number;
  aged: number;
  calls: number;
  failures: string[];
};

/**
 * Lays this run's finds over the queue as it is now. A job already there keeps its status, its
 * history and the time it was first seen; only the posting is refreshed. A new job is queued
 * when the tool can fill it, held when it cannot, and skipped when the code filters refuse it.
 */
export function mergeHourly(
  current: QueueEntry[],
  found: Job[],
  profile: Profile,
  now = new Date(),
  walled: (url: string) => boolean = isWalled,
): { entries: QueueEntry[]; added: number; updated: number; held: number; skipped: number } {
  const search = profile.search;
  if (!search) throw new Error("this profile has no search block, so there is nothing to ask the boards for");
  const byId = new Map(current.map((e) => [e.job.id, e]));
  const byKey = new Map(current.map((e) => [hourlyKey(e.job), e]));
  // A job already sent is never queued again, even if its link or location moved.
  const appliedByKey = new Map(
    current.filter((e) => e.status === "applied" || e.status === "submission_unknown").map((e) => [appliedKey(e.job), e]),
  );
  const us = usStatus(profile);
  const withAccount = (url: string) => (capabilityFor(url)?.verdict ?? "no") !== "no";
  const entries = [...current];
  let added = 0;
  let updated = 0;
  let held = 0;
  let skipped = 0;

  const stamp = now.toISOString();
  for (const job of found) {
    const existing = byId.get(job.id) ?? byKey.get(hourlyKey(job)) ?? appliedByKey.get(appliedKey(job));
    if (existing) {
      // A job keeps the link and id it was first recorded under. Changing the link would change
      // the id the record and the CSV are keyed by, and a sent application could come back as a
      // new job. Only the dates and a missing description are refreshed.
      const sent = existing.status === "applied" || existing.status === "submission_unknown";
      const sameLink = existing.job.url === job.url;
      const next: QueueEntry = {
        ...existing,
        job:
          sent || !sameLink
            ? {
                ...existing.job,
                postedAt: existing.job.postedAt ?? job.postedAt,
                postedAtExact: existing.job.postedAtExact ?? job.postedAtExact ?? null,
                ...(!existing.job.description && job.description ? { description: job.description, descriptionSource: job.descriptionSource } : {}),
              }
            : {
                ...existing.job,
                ...job,
                // A posting read again without a description keeps the one the writer may still need.
                ...(!job.description && existing.job.description ? { description: existing.job.description, descriptionSource: existing.job.descriptionSource } : {}),
              },
        updatedAt: stamp,
      };
      const at = entries.indexOf(existing);
      if (at >= 0) entries[at] = next;
      byId.set(next.job.id, next);
      byKey.set(hourlyKey(next.job), next);
      updated++;
      continue;
    }

    const applyable = canFill(job);
    const reason = preFilter(job, now, walled, us, DISCOVER.maxAgeDays, withAccount);
    const draft: QueueEntry = {
      job: job as QueueEntry["job"],
      fit: null,
      preFilterReason: reason,
      applyable,
      holdUntil: null,
      status: "skipped",
      statusReason: reason,
      attempts: 0,
      discoveredAt: stamp,
      updatedAt: stamp,
      appliedAt: null,
      notes: null,
      waitingFor: null,
      answers: [],
      replies: [],
      response: null,
    };
    if (reason) {
      skipped++;
    } else if (applyable) {
      draft.status = "queued";
      draft.statusReason = null;
    } else if (isRecent(draft, now)) {
      // Held for the person. The hourly run hands it over when the window closes.
      draft.status = "queued";
      draft.statusReason = null;
      draft.holdUntil = new Date(now.getTime() + HOURLY.windowHours * 3_600_000).toISOString();
      held++;
    } else {
      // Already too old for the page: it is the person's at once.
      draft.status = "needs_review";
      draft.statusReason = HOURLY.staleReason;
    }
    entries.push(draft);
    byId.set(job.id, draft);
    byKey.set(hourlyKey(job), draft);
    added++;
  }
  return { entries, added, updated, held, skipped };
}

export type HourlyOptions = {
  dry?: boolean;
  now?: Date;
  log?: (line: string) => void;
  /** Injected in tests so no Docker call is made. */
  runner?: JobspyRunner;
  queueFile?: string;
  rowsFile?: string;
  stateFile?: string;
};

/** When the hourly search last completed, so an hour the machine missed is still looked for. */
const HourlyState = z.object({ lastRunAt: z.string().nullable().default(null) });
export type HourlyState = z.infer<typeof HourlyState>;

export function loadHourlyState(file = PATHS.hourlyState): HourlyState {
  if (!existsSync(file)) return { lastRunAt: null };
  try {
    const parsed = HourlyState.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : { lastRunAt: null };
  } catch {
    return { lastRunAt: null };
  }
}

export function saveHourlyState(state: HourlyState, file = PATHS.hourlyState): void {
  writeAtomic(file, JSON.stringify(state, null, 2) + "\n");
}

/** How far back this run should ask: the profile's hour, widened to cover a run the machine missed. */
export function hoursToAsk(search: Search, state: HourlyState, now = new Date()): number {
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  if (!Number.isFinite(last) || last >= now.getTime()) return search.hoursOld;
  const missed = Math.ceil((now.getTime() - last) / 3_600_000) + 1;
  return Math.max(search.hoursOld, Math.min(24, missed));
}

/**
 * Runs one hourly search and writes what it finds. The search takes minutes and holds no run
 * lock, so the queue is read again under the store lock when the finds are laid over it.
 */
export async function runHourly(profile: Profile, o: HourlyOptions = {}): Promise<HourlySummary> {
  const search: Search | undefined = profile.search;
  if (!search) throw new Error("this profile has no search block. Add it with /profile before running the hourly search.");
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const files = { queue: o.queueFile, rows: o.rowsFile };

  // 1. Jobs whose twelve hours are over become the person's.
  let aged = 0;
  if (o.dry) {
    const q = loadQueue(files.queue);
    aged = ageHeldEntries(q, now).length;
  } else {
    aged = withStore(() => {
      const changed = mutateQueue((q) => ageHeldEntries(q, now), files.queue);
      let rows = loadRows(files.rows);
      for (const e of changed) rows = upsertEntry(rows, e);
      saveRows(rows, files.rows);
      return changed.length;
    });
    if (aged) log(`[hourly] ${aged} held job(s) moved to Needs you`);
  }

  // 2. Ask the boards. A run the machine missed widens the window, so its jobs are not lost.
  const state = loadHourlyState(o.stateFile);
  const hoursOld = hoursToAsk(search, state, now);
  if (hoursOld > search.hoursOld) log(`[hourly] the last run was ${state.lastRunAt ?? "never"}; asking for the last ${hoursOld} hours`);
  const result = await searchJobspy(search, { ...(o.runner ? { runner: o.runner } : {}), log, hoursOld });
  for (const f of result.failures) log(`[hourly] a board call failed: ${f}`);
  log(`[hourly] ${result.jobs.length} matching postings from ${result.calls} call(s)`);

  // 3. Lay them over the queue.
  let counts = { added: 0, updated: 0, held: 0, skipped: 0 };
  if (o.dry) {
    const q = loadQueue(files.queue);
    const r = mergeHourly(q.entries, result.jobs, profile, now);
    counts = { added: r.added, updated: r.updated, held: r.held, skipped: r.skipped };
  } else {
    counts = withStore(() => {
      const changed: QueueEntry[] = [];
      const r = mutateQueue((q) => {
        const before = new Map(q.entries.map((e) => [e.job.id, e]));
        const merged = mergeHourly(q.entries, result.jobs, profile, now);
        for (const e of merged.entries) if (!before.has(e.job.id) || before.get(e.job.id) !== e) changed.push(e);
        q.entries = merged.entries;
        q.generatedAt = now.toISOString();
        return merged;
      }, files.queue);
      let rows = loadRows(files.rows);
      for (const e of changed) rows = upsertEntry(rows, e);
      saveRows(rows, files.rows);
      return { added: r.added, updated: r.updated, held: r.held, skipped: r.skipped };
    });
  }

  // The window advances only when at least one board answered, so a wholly failed run tries again.
  if (!o.dry && result.calls > result.failures.length) saveHourlyState({ lastRunAt: now.toISOString() }, o.stateFile);
  log(`[hourly] ${counts.added} new (${counts.held} held for you), ${counts.updated} refreshed, ${counts.skipped} skipped, ${aged} aged out`);
  return { found: result.jobs.length, ...counts, aged, calls: result.calls, failures: result.failures };
}

/** Whether a queue entry is recent, re-exported so callers do not reach into the job module. */
export { isRecent };
