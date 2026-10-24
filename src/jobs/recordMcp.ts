/**
 * Recording an application the LinkedIn fork sent. The posting never came through the hourly
 * search, so this builds the one Job every record reads, reuses an entry that is already in the
 * queue for the same posting, and writes the queue and the sheet together under the store lock.
 * One posting keeps one row, however it was found.
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
  appliedAt: string;
  source?: string;
};

export type RecordFiles = { queue?: string; rows?: string };

/**
 * Marks one MCP application applied on the board. An entry for the same posting is reused when it
 * exists; otherwise one is made for the link. The queue and the sheet are written together, so a
 * row is never added twice.
 */
export function recordMcpApplication(input: McpApplicationInput, files: RecordFiles = {}): QueueEntry {
  const url = input.url || `https://www.linkedin.com/jobs/view/${input.jobId}`;
  const job: Job = {
    id: jobId(url),
    source: input.source ?? "linkedin easy apply (mcp)",
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
    entry.status = "applied";
    entry.statusReason = null;
    entry.appliedAt = input.appliedAt;
    entry.updatedAt = input.appliedAt;
    entry.applyable = false;
    saveQueue(queue, queueFile);
    // loadRows reads the full record. When the real paths are in use saveRows also rebuilds
    // applied.csv and the other views from it.
    saveRows(upsertEntry(loadRows(rowsFile), entry), rowsFile);
    return entry;
  });
}
