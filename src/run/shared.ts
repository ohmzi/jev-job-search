/**
 * What the four portals share. They are separate folders with separate queues, but they drive
 * one Chrome and one person's name goes on every application. Two files under a shared folder:
 * a lock so only one portal applies at a time, and a registry of jobs already sent, so a job
 * found in two portals is not sent twice.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOURLY } from "../config.js";
import { appliedKey } from "../jobs/keys.js";
import type { Job } from "../jobs/normalize.js";
import { writeAtomic } from "../util/store.js";

export const sharedDir = () => process.env.JEV_SHARED_DIR?.trim() || path.join(homedir(), ".local", "state", "jev");
export const globalLockFile = () => path.join(sharedDir(), "apply.lock");
export const sharedAppliedFile = () => path.join(sharedDir(), "applied.json");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

/**
 * Takes the cross-portal apply lock, waiting up to `waitMs` while another portal holds it. Null when
 * the wait ran out. The searches run in parallel; this is where the portals take turns to apply.
 */
export async function waitForGlobalRun(command: string, waitMs: number = HOURLY.applyWaitMs, pollMs: number = HOURLY.applyWaitPollMs, log: (line: string) => void = () => {}): Promise<(() => void) | null> {
  const until = Date.now() + waitMs;
  let said = false;
  for (;;) {
    const release = acquireGlobalRun(command);
    if (release) return release;
    if (Date.now() + pollMs > until) return null;
    if (!said) log(`[hourly] another portal is applying; waiting for the browser (at most ${Math.round(waitMs / 60_000)} minutes)`);
    said = true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Takes the cross-portal apply lock. Null when another live portal holds it and the lock is not
 * stale, which is the signal for an hourly run to skip this hour rather than wait.
 */
export function acquireGlobalRun(command: string): (() => void) | null {
  mkdirSync(sharedDir(), { recursive: true });
  const file = globalLockFile();
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), command }));
      closeSync(fd);
      return () => {
        const body = readJson<{ pid: number }>(file);
        if (body?.pid === process.pid) {
          try {
            rmSync(file, { force: true });
          } catch {
            /* already gone */
          }
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const body = readJson<{ pid: number; at: number }>(file);
      if (body && alive(body.pid) && Date.now() - body.at < HOURLY.lockStaleMs) return null;
      try {
        rmSync(file, { force: true });
      } catch {
        /* another portal took it over first */
      }
    }
  }
  return null;
}

export type SharedApplied = {
  key: string;
  portal: string;
  jobId: string;
  company: string;
  title: string;
  url: string;
  appliedAt: string;
};

type AppliedJob = Pick<Job, "id" | "company" | "title" | "url"> & { appliedAt?: string | null };

/** Every application any portal has confirmed. A file that cannot be read is treated as empty; the local records still hold the truth. */
export function loadSharedApplied(file = sharedAppliedFile()): SharedApplied[] {
  const parsed = readJson<{ entries?: SharedApplied[] }>(file);
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}

export function sharedAppliedKeys(file = sharedAppliedFile()): Set<string> {
  return new Set(loadSharedApplied(file).map((e) => e.key));
}

/** Adds confirmed applications to the shared registry. Returns how many were new. */
export function recordSharedApplied(jobs: AppliedJob[], portal: string, at = new Date().toISOString(), file = sharedAppliedFile()): number {
  const entries = loadSharedApplied(file);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  let added = 0;
  for (const job of jobs) {
    const key = appliedKey(job);
    if (byKey.has(key)) continue;
    byKey.set(key, { key, portal, jobId: job.id, company: job.company, title: job.title, url: job.url, appliedAt: job.appliedAt ?? at });
    added++;
  }
  if (added) writeAtomic(file, JSON.stringify({ version: 1, entries: [...byKey.values()].slice(-5000) }, null, 2) + "\n");
  return added;
}
