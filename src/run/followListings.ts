/**
 * The apply step's first move for a job whose link is an Indeed or LinkedIn listing: ask the board's
 * MCP server for the employer's own form, and take the job there. This runs inside `pipeline`, so
 * `/apply`, `daily` and the hourly apply pass all get it. The servers read the posting and return a
 * link; they apply for no one, and Chrome fills and sends the form. With no link, or a server that
 * fails, the job is left as it is and Chrome opens the listing and follows its Apply button.
 */
import { canFill } from "../jobs/fillable.js";
import type { Job } from "../jobs/normalize.js";
import { mutateQueue, type QueueEntry } from "../jobs/queue.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import type { Profile } from "../profile/schema.js";
import { easyApplyFromApplyType, listingOf, mcpCaller, resolveListings, withEmployerLink, type Caller, type ListingAnswer } from "../sources/listingLink.js";
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

/** Takes each listing entry to the employer's link where its board's MCP has one. Changes the entries it is given. Returns how many moved. */
export async function followListings(entries: QueueEntry[], profile: Profile, o: FollowOptions = {}): Promise<number> {
  const held = entries.filter((e) => listingOf(e.job.url));
  if (!held.length || o.listings === false) return 0;
  const now = o.now ?? new Date();
  const log = o.quiet ? () => {} : (line: string) => console.log(line);
  const caller = o.listings ?? mcpCaller(log);
  let answers: Map<string, ListingAnswer>;
  try {
    answers = await resolveListings(held.map((e) => e.job), {
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
  if (!answers.size) return 0;
  /** Applies one board answer: the employer's link when there is one, the method always. */
  const applyAnswer = (e: QueueEntry, answer: ListingAnswer): boolean => {
    // An Easy Apply posting has no employer link to take; its method is the answer.
    if (answer.url && answer.applyType !== "easy_apply") {
      e.job = withEmployerLink(e.job, answer.url);
      e.applyable = canFill(e.job as unknown as Job);
      if (e.applyable) e.holdUntil = null;
      return true;
    }
    const easyApply = easyApplyFromApplyType(answer.applyType, e.job.easyApply);
    if (easyApply !== e.job.easyApply) e.job = { ...e.job, easyApply };
    return false;
  };
  let moved = 0;
  let easy = 0;
  for (const e of held) {
    const answer = answers.get(e.job.id);
    if (!answer) continue;
    if (applyAnswer(e, answer)) moved++;
    else if (answer.applyType === "easy_apply") easy++;
  }
  if (!o.dry) {
    withStore(() => {
      const changed = mutateQueue((q) => {
        const out: QueueEntry[] = [];
        for (const x of q.entries) {
          const answer = answers.get(x.job.id);
          if (!answer || x.status === "applied" || x.status === "submission_unknown" || !listingOf(x.job.url)) continue;
          applyAnswer(x, answer);
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
  log(`${answers.size} of ${held.length} board listing(s) read: ${moved} led to the employer's own form${easy ? `, ${easy} Easy Apply` : ""}`);
  return moved;
}
