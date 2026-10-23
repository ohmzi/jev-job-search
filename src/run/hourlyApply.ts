/**
 * The apply half of an hourly run. It takes a small number of fresh, fillable jobs and sends
 * them with nobody watching, under the person's standing policy. A job gets two tries. After
 * that it is left in Needs you and never picked again.
 *
 * Only jobs whose link is a form the tool can fill are taken. An Indeed or LinkedIn listing is
 * not one, and stays a job for the person.
 */
import { accountGate } from "../accounts/capability.js";
import { DAILY, HOURLY, RUN } from "../config.js";
import { appliedKey } from "../jobs/keys.js";
import { loadQueue, mutateQueue, sortEntries, type QueueEntry } from "../jobs/queue.js";
import { recentFirst } from "../jobs/recency.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import type { Profile } from "../profile/schema.js";
import { withStore } from "../util/store.js";
import { boardOf, countToday, employerOf, loadPauses, localDay, pauseBoard } from "./daily.js";
import { employerKey, interleaveEmployers, noteApplied, pipeline, takeJobs } from "./pipeline.js";
import { policyRefuses, type Policy } from "./policy.js";
import { loadSharedApplied, recordSharedApplied, sharedAppliedKeys } from "./shared.js";

const brief = (e: QueueEntry) => ({ id: e.job.id, company: e.job.company, title: e.job.title });

export type HourlyApplySummary = {
  picked: { id: string; company: string; title: string }[];
  applied: string[];
  left: { id: string; company: string; title: string; reason: string }[];
  /** Jobs marked applied because another portal had already sent them. */
  synced: number;
  /** Why nothing was taken, when that is the case. */
  reason: string | null;
};

/**
 * The jobs one hourly pass may take: queued, inside the two-attempt cap, admitted by the policy
 * (a fresh job without a score is admitted), and not already in the shared registry. A board-only
 * listing is included too: the page may turn out to have a form, and if it wants a sign-in the
 * person gets the window. Fillable jobs go first, then board-only ones, recent before older.
 */
export function pickFresh(
  entries: QueueEntry[],
  policy: Policy,
  now = new Date(),
  count: number = HOURLY.applyCount,
  gate: (url: string) => string | null = accountGate(),
): QueueEntry[] {
  const seen = sharedAppliedKeys();
  const eligible = entries.filter(
    (e) =>
      e.status === "queued" &&
      e.attempts < HOURLY.maxAttempts &&
      !seen.has(appliedKey(e.job)) &&
      gate(e.job.url) === null &&
      policyRefuses(e, policy, now) === null,
  );
  // Fillable links first; a board-only page still gets its turn, because it may open on a form.
  const ordered = [
    ...recentFirst(sortEntries(eligible.filter((e) => e.applyable !== false)), now),
    ...recentFirst(sortEntries(eligible.filter((e) => e.applyable === false)), now),
  ];
  const perEmployer = new Map<string, number>();
  const picked: QueueEntry[] = [];
  for (const e of ordered) {
    if (picked.length >= count) break;
    const key = employerKey(e.job.company);
    if ((perEmployer.get(key) ?? 0) >= 1) continue;
    perEmployer.set(key, 1);
    picked.push(e);
  }
  return interleaveEmployers(picked);
}

type DayCounts = ReturnType<typeof countToday>;
type Pauses = ReturnType<typeof loadPauses>;

/**
 * The daily limits, applied to the hourly pass too: the day's target, the per-board and
 * per-employer counts, the employer's open forms, and a board left alone after a human check.
 */
export function mayApplyToday(e: QueueEntry, policy: Policy, day: DayCounts, pauses: Pauses, now = new Date()): boolean {
  const board = boardOf(e.job);
  const paused = pauses[board];
  if (paused && Date.parse(paused.until) > now.getTime()) return false;
  if (day.sent + day.unconfirmed >= policy.target) return false;
  if ((day.board.get(board) ?? 0) >= DAILY.perBoard) return false;
  const employer = employerOf(e.job);
  if ((day.employer.get(employer) ?? 0) >= DAILY.perEmployerPerDay) return false;
  if ((day.open.get(employer) ?? 0) >= DAILY.openPerEmployer) return false;
  return true;
}

/**
 * What one attempt leaves behind. A sent job, a held form and an unconfirmed click are final
 * outcomes and are never retried. A failure gets one more try; after the second, the job is the
 * person's. Mutates the entry and says whether it changed.
 */
export function settleAfterAttempt(e: QueueEntry, now = new Date()): boolean {
  if (["applied", "submission_unknown", "awaiting_user_action", "awaiting_email_verification", "login_required", "blocked", "skipped"].includes(e.status)) return false;
  if (e.attempts >= HOURLY.maxAttempts) {
    e.status = "needs_review";
    e.statusReason = `left for you after ${e.attempts} attempts`;
    e.waitingFor = null;
    e.holdUntil = null;
    e.updatedAt = now.toISOString();
    return true;
  }
  if (e.status === "failed" || e.status === "in_progress") {
    e.status = "queued";
    e.statusReason = `attempt ${e.attempts} did not finish; one more try${e.statusReason ? `: ${e.statusReason}` : ""}`;
    e.updatedAt = now.toISOString();
    return true;
  }
  return false;
}

/**
 * Marks local jobs applied when another portal already sent the same company and title. This is
 * what stops the four portals from sending one job twice.
 */
function syncFromShared(now: Date): number {
  const shared = new Map(loadSharedApplied().map((s) => [s.key, s]));
  if (!shared.size) return 0;
  return withStore(() => {
    const changed = mutateQueue((q) => {
      const out: QueueEntry[] = [];
      for (const e of q.entries) {
        const hit = shared.get(appliedKey(e.job));
        if (!hit) continue;
        if (["applied", "submission_unknown", "in_progress", "awaiting_user_action", "awaiting_email_verification"].includes(e.status)) continue;
        e.status = "applied";
        e.appliedAt = hit.appliedAt;
        e.statusReason = `applied in ${hit.portal}`;
        e.waitingFor = null;
        e.holdUntil = null;
        e.updatedAt = now.toISOString();
        out.push(e);
      }
      return out;
    });
    let rows = loadRows();
    for (const e of changed) rows = upsertEntry(rows, e);
    saveRows(rows);
    return changed.length;
  });
}

export type HourlyApplyOptions = {
  dry?: boolean;
  now?: Date;
  count?: number;
  log?: (line: string) => void;
};

/**
 * Runs the apply pass. The caller holds the global apply lock and the browser run lock; this
 * function assumes Chrome is up. A failure on one job never stops the next.
 */
export async function applyFresh(profile: Profile, policy: Policy, o: HourlyApplyOptions = {}): Promise<HourlyApplySummary> {
  const now = o.now ?? new Date();
  const portal = profile.search?.portal ?? "portal";
  const log = o.log ?? (() => {});
  const summary: HourlyApplySummary = { picked: [], applied: [], left: [], synced: 0, reason: null };

  summary.synced = o.dry ? 0 : syncFromShared(now);
  if (summary.synced) log(`[hourly] ${summary.synced} job(s) already applied in another portal`);

  const all = loadQueue().entries;
  const day = countToday(all, localDay(now));
  const pauses = loadPauses();
  const picked = pickFresh(
    all.filter((e) => mayApplyToday(e, policy, day, pauses, now)),
    policy,
    now,
    o.count ?? HOURLY.applyCount,
  );
  summary.picked = picked.map(brief);
  if (!picked.length) {
    if (day.sent + day.unconfirmed >= policy.target) {
      summary.reason = `the day's target of ${policy.target} applications is reached (${day.sent} sent, ${day.unconfirmed} unconfirmed)`;
    } else if (!all.some((e) => e.status === "queued")) {
      summary.reason = "no queued job is left";
    } else {
      summary.reason = "no queued job passes the policy and the two-attempt cap";
    }
  }
  if (o.dry) return summary;

  for (const e of picked) {
    const board = boardOf(e.job);
    const last = day.last.get(board);
    if (last && Date.now() - last < DAILY.gapMs[0]) {
      log(`[hourly] ${board} had a submission minutes ago; the rest wait for the next hour`);
      break;
    }
    const entries = takeJobs([e.job.id], { count: 1, dry: false, shared: sharedAppliedKeys() });
    if (!entries.length) continue;
    // The run may take a listing to the employer's link, and a job's id follows its link: read it after the run.
    const taken = entries[0] as QueueEntry;
    let sent: string[] = [];
    try {
      const r = await pipeline(entries, {
        submit: true,
        dry: false,
        fresh: false,
        quiet: true,
        waitAtSignIn: true,
        signInWaitMs: HOURLY.signInWaitMs,
        humanWaitMs: RUN.humanWaitMs,
        keepOpenOnNeedsReview: true,
      });
      sent = r.sent;
    } catch (err) {
      log(`[hourly] ${e.job.company}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (sent.length) {
      await noteApplied(sent);
      const done = loadQueue().entries.filter((x) => sent.includes(x.job.id));
      recordSharedApplied(done.map((x) => ({ ...x.job, appliedAt: x.appliedAt })), portal);
      summary.applied.push(...sent);
      day.sent += sent.length;
      day.board.set(board, (day.board.get(board) ?? 0) + sent.length);
      const employer = employerOf(e.job);
      day.employer.set(employer, (day.employer.get(employer) ?? 0) + sent.length);
      day.last.set(board, Date.now());
    }
    withStore(() => {
      const out = mutateQueue((q) => {
        const next: QueueEntry[] = [];
        for (const x of q.entries) if (x.job.id === taken.job.id && settleAfterAttempt(x, now)) next.push(x);
        return next;
      });
      let rows = loadRows();
      for (const x of out) rows = upsertEntry(rows, x);
      saveRows(rows);
    });
    const after = loadQueue().entries.find((x) => x.job.id === taken.job.id);
    if (after && (after.status === "awaiting_user_action" || after.status === "awaiting_email_verification") && (after.waitingFor === "human_code" || after.waitingFor === "robot_check")) {
      pauseBoard(board, "it asked for a human check", new Date());
      log(`[hourly] ${board} is left alone until tomorrow: it asked for a human check`);
    }
    if (after?.status === "needs_review") summary.left.push({ ...brief(after), reason: after.statusReason ?? "" });
  }
  return summary;
}
