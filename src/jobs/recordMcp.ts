/**
 * Recording an application the LinkedIn fork sent. The posting never came through the hourly
 * search, so this builds the one Job every record reads, reuses an entry that is already in the
 * queue for the same posting, and writes the queue and the sheet together under the store lock.
 * One posting keeps one row, however it was found.
 *
 * The queue write is the safety record and is never swallowed: before the fork is asked to send,
 * the entry goes in as submission_unknown, so a later run can never send the same posting again.
 * The sheet is a second write; a failure there is reported for reconcile but does not undo the
 * queue's record of what happened.
 */
import { PATHS } from "../config.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import { withStore } from "../util/store.js";
import { atsFromUrl, jobId, type Job } from "./normalize.js";
import { entryFor, loadQueue, saveQueue, type QueueEntry } from "./queue.js";

export type McpApplicationInput = {
  /** The board's own posting id. The record's id still follows the link, as every other record's does. */
  jobId: string;
  company: string;
  title: string;
  location: string;
  url: string;
  /** Null when the application was already on the board and its time is unknown. */
  appliedAt: string | null;
  source?: string;
};

export type RecordFiles = { queue?: string; rows?: string };
/** The entry as written, and whether the sheet could be written after the queue. */
export type McpRecord = { entry: QueueEntry; rowsWritten: boolean };

const DEFAULT_SOURCE = "linkedin easy apply (mcp)";

function write(input: McpApplicationInput, status: "applied" | "submission_unknown", files: RecordFiles, log?: (line: string) => void): McpRecord {
  const url = input.url || `https://www.linkedin.com/jobs/view/${input.jobId}`;
  const source = input.source ?? DEFAULT_SOURCE;
  const job: Job = {
    id: jobId(url),
    source,
    company: input.company,
    title: input.title,
    url,
    ats: atsFromUrl(url),
    locations: [input.location],
    postedAt: null,
    terms: [],
    sponsorship: "unknown",
    degrees: [],
    category: null,
  };
  return withStore(() => {
    const queueFile = files.queue ?? PATHS.queue;
    const rowsFile = files.rows ?? PATHS.applications;
    const queue = loadQueue(queueFile);
    const existing = queue.entries.find((e) => e.job.id === job.id || e.job.url === url);
    const entry = existing ?? entryFor(job, null, null);
    if (!existing) queue.entries.push(entry);
    // A posting found by the search keeps the source that sent it, not the one the search gave it.
    entry.job.source = source;
    entry.status = status;
    entry.statusReason = status === "submission_unknown" ? "the linkedin fork did not confirm the application" : null;
    entry.appliedAt = status === "applied" ? input.appliedAt : null;
    entry.updatedAt = new Date().toISOString();
    entry.applyable = false;
    saveQueue(queue, queueFile);
    let rowsWritten = true;
    try {
      // loadRows reads the full record. When the real paths are in use saveRows also rebuilds
      // applied.csv and the other views from it.
      saveRows(upsertEntry(loadRows(rowsFile), entry), rowsFile);
    } catch (err) {
      rowsWritten = false;
      const label = [input.company, input.title].filter(Boolean).join(" - ") || url;
      log?.(`[easy] the sheet could not be written for ${label}: ${err instanceof Error ? err.message : String(err)}. Reconcile ${rowsFile} with ${queueFile}.`);
    }
    return { entry, rowsWritten };
  });
}

/** Records that a send is about to be attempted. Written before the fork's submit tool is called. */
export function recordMcpSubmission(input: McpApplicationInput, files: RecordFiles = {}, log?: (line: string) => void): McpRecord {
  return write(input, "submission_unknown", files, log);
}

/** Promotes a confirmed application to applied. Leaves the time null when it is unknown. */
export function recordMcpApplication(input: McpApplicationInput, files: RecordFiles = {}, log?: (line: string) => void): McpRecord {
  return write(input, "applied", files, log);
}
