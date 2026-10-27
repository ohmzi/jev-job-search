/**
 * The apply step's first move for a job whose link is an Indeed or LinkedIn listing: ask the board's
 * MCP server for the employer's own form, and take the job there. This runs inside `pipeline`, so
 * `/apply`, `daily` and the hourly apply pass all get it. The servers read the posting and return a
 * link; this lookup sends nothing. Chrome fills the employer's form, and an Easy Apply posting is
 * sent by the LinkedIn fork in the apply step. A posting that takes Easy Apply has no employer link:
 * it keeps its board link and is marked applyable so the apply run takes it. Any other posting with
 * no link, or a server that fails, is left as it is and Chrome opens the listing and follows its
 * Apply button.
 */
import { canFill } from "../jobs/fillable.js";
import type { Job } from "../jobs/normalize.js";
import { mutateQueue, type QueueEntry } from "../jobs/queue.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import type { Profile } from "../profile/schema.js";
import { easyApplyFromApplyType, listingOf, mcpCaller, resolveListings, withEmployerLink, type Caller, type ResolvedListing } from "../sources/listingLink.js";
import { withStore } from "../util/store.js";

export type FollowOptions = {
  /** A rehearsal changes nothing on disk: the job is taken to the employer's link for this run only. */
  dry?: boolean;
  quiet?: boolean;
  /** The Indeed and LinkedIn MCP servers. False skips them; left out, the real servers are used. */
  listings?: Caller | false;
  /** Where the answers of the boards' servers are kept. */
  linksFile?: string;
  /** Where the queue and the sheet are kept, for tests. */
  queueFile?: string;
  rowsFile?: string;
  now?: Date;
};

/** Takes each listing entry to the employer's link where its board's MCP has one, or marks an Easy Apply listing applyable on its board link. Changes the entries it is given. Returns how many moved. */
export async function followListings(entries: QueueEntry[], profile: Profile, o: FollowOptions = {}): Promise<number> {
  const held = entries.filter((e) => listingOf(e.job.url));
  if (!held.length || o.listings === false) return 0;
  const now = o.now ?? new Date();
  const log = o.quiet ? () => {} : (line: string) => console.log(line);
  const caller = o.listings ?? mcpCaller(log);
  let links: Map<string, ResolvedListing>;
  try {
    links = await resolveListings(held.map((e) => e.job), {
      call: caller.call,
      country: profile.search?.countryIndeed ?? "USA",
      now,
      log,
      ...(o.dry ? { dry: true } : {}),
      ...(o.linksFile ? { cacheFile: o.linksFile } : {}),
    });
  } finally {
    caller.close();
  }
  const withLink = [...links.values()].filter((r) => r.url !== null).length;
  const move = (e: QueueEntry, url: string) => {
    e.job = withEmployerLink(e.job, url);
    e.applyable = canFill(e.job as unknown as Job);
    if (e.applyable) e.holdUntil = null;
  };
  const isLinkedIn = (e: QueueEntry) => listingOf(e.job.url)?.board === "linkedin";
  // A posting that takes Easy Apply has no employer link. It keeps its board link and is handed to
  // the apply run. Only the walk's own apply type may mark it: an external, unknown, closed or
  // unresolved posting stays out of the fork and goes to Chrome, which follows its Apply button.
  const markResolved = (e: QueueEntry, resolved: ResolvedListing | undefined) => {
    // The answer is kept on the job whether or not it changes where the apply run takes it.
    const easyApply = easyApplyFromApplyType(resolved?.applyType ?? null, e.job.easyApply);
    if (easyApply !== e.job.easyApply) e.job = { ...e.job, easyApply };
    e.applyable = resolved?.applyType === "easy_apply";
    if (e.applyable) e.holdUntil = null;
  };
  const heldIds = new Set(held.map((e) => e.job.id));
  for (const e of held) {
    const resolved = links.get(e.job.id);
    if (resolved?.url) move(e, resolved.url);
    else if (isLinkedIn(e) && e.status !== "applied" && e.status !== "submission_unknown") markResolved(e, resolved);
  }
  if (!o.dry) {
    withStore(() => {
      const changed = mutateQueue((q) => {
        const out: QueueEntry[] = [];
        for (const x of q.entries) {
          if (x.status === "applied" || x.status === "submission_unknown" || !listingOf(x.job.url)) continue;
          const resolved = links.get(x.job.id);
          if (resolved?.url) move(x, resolved.url);
          else if (heldIds.has(x.job.id) && isLinkedIn(x)) markResolved(x, resolved);
          else continue;
          x.updatedAt = now.toISOString();
          out.push(x);
        }
        return out;
      }, o.queueFile);
      let rows = loadRows(o.rowsFile);
      for (const x of changed) rows = upsertEntry(rows, x);
      saveRows(rows, o.rowsFile);
    });
  }
  log(`${withLink} of ${held.length} board listing(s) led to the employer's own form`);
  return withLink;
}
