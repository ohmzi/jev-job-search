/**
 * The event log: one JSON line for every step the tool takes, so a day of runs can be read back
 * and the rules tuned from what actually happened. Each portal writes its own file per local day
 * under data/runs/events/ (git-ignored); the combined board reads the four through their
 * dashboards. Every string is scrubbed, links keep only their origin and path, and fields whose
 * name says secret are dropped. Writing an event never throws: a log must not stop a run.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EVENTS, PATHS } from "../config.js";
import { safeUrl, scrub } from "../util/redact.js";

export type EventContext = { portal: string; run: string; cmd: string };

const context: EventContext = { portal: path.basename(PATHS.root), run: randomUUID().slice(0, 8), cmd: "" };
let pruned = false;

/** Names the process for every event it writes: which portal, which command. The run id stays for the process. */
export function setEventContext(c: Partial<Omit<EventContext, "run">>): void {
  if (c.portal) context.portal = c.portal;
  if (c.cmd !== undefined) context.cmd = c.cmd;
}

export function eventContext(): EventContext {
  return { ...context };
}

const dir = () => process.env.JEV_EVENTS_DIR || PATHS.events;
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const SECRET_KEY = /^(password|passwd|secret|token|otp|code|cookie|authorization|apikey|api_key)$/i;

/** A value made safe to keep: scrubbed, links cut to origin and path, long text shortened, secret-named fields left out. */
export function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    const s = /^https?:\/\//i.test(value) ? safeUrl(value) : value;
    const t = scrub(s);
    return t.length > EVENTS.maxString ? `${t.slice(0, EVENTS.maxString)}…` : t;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return clean(value.message, depth);
  if (depth >= 4) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, EVENTS.maxItems).map((v) => clean(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!SECRET_KEY.test(k) && typeof v !== "function") out[k] = clean(v, depth + 1);
    return out;
  }
  return String(value);
}

/** Old days go once a process, so the folder keeps EVENTS.keepDays of history. */
function prune(at: string, now: Date): void {
  if (pruned) return;
  pruned = true;
  const cutoff = day(new Date(now.getTime() - EVENTS.keepDays * 86_400_000));
  for (const f of readdirSync(at)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) rmSync(path.join(at, f), { force: true });
}

/** Writes one event. `kind` is a dotted name (hourly.boards, job.status, apply.result); `data` holds its numbers and names. */
export function logEvent(kind: string, data: Record<string, unknown> = {}, now = new Date()): void {
  if (process.env.VITEST && !process.env.JEV_EVENTS_DIR) return;
  try {
    const at = dir();
    mkdirSync(at, { recursive: true });
    prune(at, now);
    const line = JSON.stringify({ at: now.toISOString(), portal: context.portal, run: context.run, cmd: context.cmd, kind, ...(clean(data) as Record<string, unknown>) });
    appendFileSync(path.join(at, `${day(now)}.jsonl`), line + "\n");
  } catch {
    /* the log is best effort */
  }
}

/** Times a step and writes `kind` with its result's numbers and how long it took, or the error it ended with. */
export async function timed<T>(kind: string, data: Record<string, unknown>, work: () => Promise<T>, summary: (r: T) => Record<string, unknown> = () => ({})): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await work();
    logEvent(kind, { ...data, ok: true, ms: Date.now() - t0, ...summary(r) });
    return r;
  } catch (err) {
    logEvent(kind, { ...data, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Every line the process prints also becomes a `say` event, so nothing a run reported is lost. The `events` command's own output is not, or reading the log would grow it. */
export function captureOutput(): void {
  for (const [name, stream] of [["out", process.stdout], ["err", process.stderr]] as const) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    let partial = "";
    (stream as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) => {
      if (typeof chunk === "string") {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop() ?? "";
        if (context.cmd !== "events") for (const l of lines) if (l.trim()) logEvent("say", { stream: name, line: l });
      }
      return write(chunk, ...rest);
    };
  }
}

export const Event = z.object({ at: z.string(), portal: z.string(), run: z.string(), cmd: z.string(), kind: z.string() }).passthrough();
export type Event = z.infer<typeof Event>;

/** This portal's events from the last `days` days, oldest first, at most `limit` of them (the newest). */
export function readEvents(days: number = EVENTS.serveDays, o: { dir?: string; now?: Date; limit?: number; kinds?: string[] } = {}): Event[] {
  const at = o.dir ?? dir();
  if (!existsSync(at)) return [];
  const now = o.now ?? new Date();
  const from = day(new Date(now.getTime() - (days - 1) * 86_400_000));
  const out: Event[] = [];
  for (const f of readdirSync(at).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= from).sort()) {
    for (const line of readFileSync(path.join(at, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = Event.safeParse(JSON.parse(line));
        if (e.success && (!o.kinds || o.kinds.some((k) => e.data.kind === k || e.data.kind.startsWith(`${k}.`)))) out.push(e.data);
      } catch {
        /* a torn line from a crash is skipped */
      }
    }
  }
  const limit = o.limit ?? EVENTS.maxServe;
  return out.length > limit ? out.slice(out.length - limit) : out;
}
