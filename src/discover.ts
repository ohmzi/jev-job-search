/**
 * The discover pipeline: sources → dedupe → pre-filter → describe → rate → queue.
 * No browser involved. Safe to run as often as you like; everything is cached
 * and previously applied jobs keep their status.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ATS_SEARCH, DISCOVER, PATHS, CACHE } from "./config.js";
import { JevClient } from "./jev/client.js";
import { describe } from "./jobs/describe.js";
import { capabilityFor } from "./accounts/capability.js";
import { preFilter } from "./jobs/hardFilters.js";
import { isWalled, learnedWalledHosts } from "./jobs/walled.js";
import { ageDays, dedupe, type Job } from "./jobs/normalize.js";
import { entryFor, KEPT_ON_REDISCOVERY, loadQueue, mutateQueue, sortEntries, type QueueEntry, type QueueFile, type QueueStatus } from "./jobs/queue.js";
import { withStore } from "./util/store.js";

/** Jobs whose earlier rating still stands: a run or a person already settled them. */
const NOT_RERATED: readonly QueueStatus[] = KEPT_ON_REDISCOVERY.filter((s) => s !== "needs_review" && s !== "in_progress");
/** Jobs kept in the queue when their posting is gone from every list: sent, unconfirmed, or waiting on the person or a run. */
const CARRIED_OVER: readonly QueueStatus[] = KEPT_ON_REDISCOVERY.filter((s) => s !== "skipped" && s !== "failed");
import { rateJob, type FitResult } from "./jobs/rate.js";
import { loadRows, saveRows, upsertEntry } from "./log/csv.js";
import { usStatus, type Profile, type Search } from "./profile/schema.js";
import type { Answer } from "./jev/types.js";
import { KeyedCache } from "./util/cache.js";
import { fetchAshbyBoard } from "./sources/ats/ashby.js";
import { fetchGreenhouseBoard } from "./sources/ats/greenhouse.js";
import { fetchLeverBoard } from "./sources/ats/lever.js";
import { fetchWorkableBoard } from "./sources/ats/workable.js";
import { searchWorkdaySite } from "./sources/ats/workday.js";
import { boardsFromJobs, type Board } from "./sources/companies.js";
import { searchFreehire, type FreehireCall } from "./sources/freehire.js";
import { companyExcluded, locationWanted, titleWanted } from "./sources/jobspy.js";
import { importSheet } from "./sources/sheetImport.js";
import { mapLimit } from "./util/http.js";

const EARLY_CAREER = new RegExp(ATS_SEARCH.earlyCareerTitle, "i");
const DEFAULT_TITLE = new RegExp(ATS_SEARCH.defaultTitle, "i");

/** A title for students or new graduates. Never kept from a board. */
export function isEarlyCareerTitle(title: string): boolean {
  return EARLY_CAREER.test(title);
}

/** The title test a board's postings are put to: the portal's own roles, or any software title without a portal. */
export function boardTitleWanted(title: string, search?: Search): boolean {
  if (isEarlyCareerTitle(title)) return false;
  return search ? titleWanted(title, search) : DEFAULT_TITLE.test(title);
}

/** True when a board posting is one the portal wants: its roles, its area, not an employer it leaves out. */
export function boardJobWanted(job: Pick<Job, "title" | "locations" | "company">, search?: Search): boolean {
  if (!boardTitleWanted(job.title, search)) return false;
  if (!search) return true;
  return locationWanted(job.locations, search) && !companyExcluded(job.company, search.excludeCompanies);
}

export type DiscoverOptions = {
  boards?: boolean;
  limit?: number;
  log?: (line: string) => void;
  now?: Date;
  /** The portal's search: which roles, which places, which terms. Without one, any software title anywhere is kept. */
  search?: Search;
  /** Jobs the tool has seen before (the queue). Only the boards they point at are used. */
  known?: { ats: string; url: string; company: string }[];
  /** Ask freehire for employers the tool does not know yet. Needs a portal search. */
  freehire?: boolean;
  /** Stands in for the openings MCP server in tests. */
  freehireCall?: FreehireCall;
  /** Consider postings up to this many days old, for one search. The default is DISCOVER.maxAgeDays. */
  maxAgeDays?: number;
};

export type DiscoverSummary = {
  collected: number;
  unique: number;
  preFiltered: number;
  rated: number;
  /** How many of those ratings came from the cache and cost nothing. */
  reused: number;
  queued: number;
  belowThreshold: number;
  skippedByJev: number;
  jevCostUsd: number;
  jevCalls: number;
};

/**
 * The employers' own boards: the seed list, every board a known or imported job points at, and the
 * boards freehire names, read whole (Greenhouse, Lever, Ashby, Workable) or searched (Workday), then
 * put to the portal's rules. The hourly search and `discover` both read them through here.
 */
export async function collectBoardJobs(opts: DiscoverOptions & { extra?: Job[] } = {}): Promise<Job[]> {
  const log = opts.log ?? (() => {});
  const maxAgeDays = opts.maxAgeDays ?? DISCOVER.maxAgeDays;
  const found = opts.search && opts.freehire !== false
    ? await searchFreehire(opts.search, maxAgeDays, { log, ...(opts.freehireCall ? { call: opts.freehireCall } : {}) })
    : { jobs: [] as Job[], boards: [] as Board[] };

  const boards = boardsFromJobs([...(opts.extra ?? []), ...found.jobs, ...(opts.known ?? [])], undefined, found.boards);
  log(`[sources] polling ${boards.length} company boards`);
  const terms = opts.search?.terms ?? ATS_SEARCH.defaultTerms;
  const titleOk = (title: string) => boardTitleWanted(title, opts.search);
  const results = await mapLimit(boards, DISCOVER.fetchConcurrency, (b: Board) =>
    b.ats === "greenhouse" ? fetchGreenhouseBoard(b.slug, b.company)
    : b.ats === "lever" ? fetchLeverBoard(b.slug, b.company)
    : b.ats === "ashby" ? fetchAshbyBoard(b.slug, b.company)
    : b.ats === "workable" ? fetchWorkableBoard(b.slug, b.company)
    : searchWorkdaySite(b.slug, terms, titleOk, maxAgeDays),
  );
  const now = opts.now ?? new Date();
  const fresh = (j: Job) => {
    const age = ageDays(j, now);
    return age === null || age <= maxAgeDays;
  };
  // The employer's own board comes first, so its record is the one a duplicate merges into.
  const fromBoards: Job[] = [];
  results.forEach((r) => {
    if (r.ok) fromBoards.push(...r.value.filter((j) => boardJobWanted(j, opts.search) && fresh(j)));
  });
  const fromFreehire = found.jobs.filter((j) => boardJobWanted(j, opts.search) && fresh(j));
  log(`[sources] boards contributed ${fromBoards.length} postings, freehire ${fromFreehire.length}`);
  return dedupe([...fromBoards, ...fromFreehire]);
}

export async function collectJobs(opts: DiscoverOptions = {}): Promise<Job[]> {
  const log = opts.log ?? (() => {});
  const imports: Job[] = [];
  if (existsSync(PATHS.imports)) {
    for (const f of readdirSync(PATHS.imports).filter((f) => f.endsWith(".csv"))) {
      try {
        const imported = importSheet(path.join(PATHS.imports, f));
        log(`[sources] ${f}: ${imported.length} rows`);
        imports.push(...imported);
      } catch (e) {
        log(`[sources] ${f} failed: ${String(e)}`);
      }
    }
  }
  if (opts.boards === false) return dedupe(imports);
  return dedupe([...(await collectBoardJobs({ ...opts, extra: imports })), ...imports]);
}

/** What a search decided about one posting. */
export type Decided = { job: Job; fit: FitResult | null; reason: string | null; failed?: string };

/**
 * The queue after a search: every posting the search saw, with what a run or a person decided
 * about it kept, plus every job the search did not see that was sent, is unconfirmed, or waits on
 * someone. A posting that left the lists must stay: dropped, it could come back later as a new job
 * and be applied to twice.
 */
/**
 * What a search found, laid over the queue as it is now. `since` is when the search began: a job
 * the search did not see, which another process added or changed after that (a link applied to, an
 * answer saved in the dashboard), is somebody's work in progress and is kept whatever its status.
 */
export function mergeDecided(current: QueueEntry[], decided: Decided[], since?: string): QueueEntry[] {
  const byId = new Map(current.map((e) => [e.job.id, e]));
  const entries = decided.map((d) => {
    const before = byId.get(d.job.id);
    // A job that was not read again this time keeps the posting text it had: the writer needs it on a retry.
    const job = !d.job.description && before?.job.description ? { ...d.job, description: before.job.description, ...(before.job.descriptionSource ? { descriptionSource: before.job.descriptionSource } : {}) } : d.job;
    const e = entryFor(job as Job, d.fit, d.reason, before);
    // A rating that failed marks a job nobody settled as failed; one a run or a person settled keeps its status.
    if (d.failed && !(before && KEPT_ON_REDISCOVERY.includes(before.status))) {
      e.status = "failed";
      e.statusReason = d.failed;
    }
    return e;
  });
  const seen = new Set(entries.map((e) => e.job.id));
  for (const e of current) if (!seen.has(e.job.id) && (CARRIED_OVER.includes(e.status) || (!!since && e.updatedAt > since))) entries.push(e);
  return sortEntries(entries);
}

/**
 * Writes a search's findings. A search runs for minutes and holds no run lock, since it never
 * touches the browser, so an apply run, the dashboard or a second search may change the queue
 * meanwhile. Nothing the search read at its start is written back: the queue is read again here,
 * under the store lock, the findings are laid over what it holds now, and it is saved whole.
 */
export function writeDecided(decided: Decided[], now: Date, since: string, files: { queue?: string; rows?: string } = {}): QueueFile {
  return withStore(() => {
    const merged = mutateQueue((q) => {
      q.generatedAt = now.toISOString();
      q.entries = mergeDecided(q.entries, decided, since);
      return q;
    }, files.queue);
    let rows = loadRows(files.rows);
    for (const e of merged.entries) rows = upsertEntry(rows, e);
    saveRows(rows, files.rows);
    return merged;
  });
}

export async function discover(profile: Profile, jev: JevClient, opts: DiscoverOptions = {}): Promise<{ queue: QueueFile; summary: DiscoverSummary }> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  // The clock's own time, not the one a test may set: it is compared with the times other processes stamp on what they change.
  const began = new Date().toISOString();
  const previous = loadQueue();
  const prevById = new Map(previous.entries.map((e) => [e.job.id, e]));

  const all = await collectJobs({ ...opts, ...(profile.search ? { search: profile.search } : {}), known: previous.entries.map((e) => e.job) });
  const learned = learnedWalledHosts();
  const us = usStatus(profile);
  const collected = all.length;
  log(`[discover] ${collected} unique postings`);

  // What this search decided about each posting. The queue entries are built from these at the end,
  // against the queue as it is then: a search takes minutes, and a run may record outcomes meanwhile.
  const decided: Decided[] = [];
  const kept: Job[] = [];
  // An account board counts when the person has an account there or allowed one, even if today's limit of new accounts is used up.
  const withAccount = (url: string) => (capabilityFor(url)?.verdict ?? "no") !== "no";
  for (const job of all) {
    const reason = preFilter(job, now, (url) => isWalled(url, learned), us, opts.maxAgeDays, withAccount);
    if (reason) decided.push({ job, fit: null, reason });
    else kept.push(job);
  }
  log(`[discover] ${kept.length} pass the code filters, ${decided.length} do not`);

  // Jobs with a terminal status from an earlier run are not re-rated.
  const toRate = kept.filter((j) => {
    const prev = prevById.get(j.id);
    if (prev && NOT_RERATED.includes(prev.status) && prev.fit) {
      decided.push({ job: j, fit: prev.fit as FitResult, reason: null });
      return false;
    }
    return true;
  });
  const limited = typeof opts.limit === "number" ? toRate.slice(0, opts.limit) : toRate;
  log(`[discover] fetching ${limited.length} descriptions`);
  const described = await mapLimit(limited, DISCOVER.fetchConcurrency, (j) => describe(j));
  const ready = described.map((r, i) => (r.ok ? r.value : (limited[i] as Job)));

  log(`[discover] rating ${ready.length} with DeepSeek`);
  let done = 0;
  const ratings = CACHE.ratings ? new KeyedCache<Record<string, Answer>>(PATHS.ratings) : undefined;
  const rated = await mapLimit(ready, DISCOVER.rateConcurrency, async (j) => {
    const fit = await rateJob(jev, j, profile, now, ratings);
    done++;
    if (done % 25 === 0) log(`[discover] rated ${done}/${ready.length} (spend $${jev.usage.costUsd.toFixed(4)})`);
    return fit;
  });
  ratings?.save();
  let ratedCount = 0;
  rated.forEach((r, i) => {
    const job = ready[i] as Job;
    if (r.ok) {
      ratedCount++;
      decided.push({ job, fit: r.value, reason: null });
    } else {
      decided.push({ job, fit: null, reason: null, failed: `rating failed: ${String(r.error).slice(0, 120)}` });
    }
  });

  const queue = writeDecided(decided, now, began);

  const summary: DiscoverSummary = {
    collected,
    unique: all.length,
    preFiltered: all.length - kept.length,
    rated: ratedCount,
    reused: ratings?.hits ?? 0,
    queued: queue.entries.filter((e) => e.status === "queued").length,
    belowThreshold: queue.entries.filter((e) => e.fit?.decision === "below_threshold").length,
    skippedByJev: queue.entries.filter((e) => e.fit?.decision === "skip").length,
    jevCostUsd: jev.usage.costUsd,
    jevCalls: jev.usage.calls,
  };
  return { queue, summary };
}
