/**
 * Reads the event log back as a report: what each portal ran, what each source gave, which boards
 * yield and which never do, where jobs stopped on the way to a confirmation, and what forms asked
 * that the tool could not answer. Pure: it is given events and returns numbers.
 */
import type { Event } from "./events.js";

type Count = Record<string, number>;
const bump = (c: Count, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};
const top = (c: Count, n: number) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export type Analysis = {
  from: string | null;
  to: string | null;
  events: number;
  portals: Record<string, {
    runs: Count;
    failedRuns: number;
    minutes: Count;
    jobspy: { queries: number; failed: number; rows: number; kept: number };
    freehire: { calls: number; failed: number; returned: number; kept: number };
    boards: { reads: number; failed: number; open: number; kept: number };
    hourlyFresh: number;
    added: Count;
    transitions: Count;
    applied: number;
    unconfirmed: number;
    picked: number;
    notPicked: Count;
    lockWaits: number;
    lockWaitMs: number;
    lockGaveUp: number;
    easyApplied: number;
  }>;
  boards: { key: string; ats: string; company: string; reads: number; failed: number; open: number; kept: number }[];
  setAside: Count;
  formBlocks: Count;
  formFailedFields: Count;
  submit: Count;
};

const blank = (): Analysis["portals"][string] => ({
  runs: {}, failedRuns: 0, minutes: {},
  jobspy: { queries: 0, failed: 0, rows: 0, kept: 0 },
  freehire: { calls: 0, failed: 0, returned: 0, kept: 0 },
  boards: { reads: 0, failed: 0, open: 0, kept: 0 },
  hourlyFresh: 0, added: {}, transitions: {}, applied: 0, unconfirmed: 0, picked: 0, notPicked: {},
  lockWaits: 0, lockWaitMs: 0, lockGaveUp: 0, easyApplied: 0,
});

export function analyzeEvents(events: Event[]): Analysis {
  const a: Analysis = { from: events[0]?.at ?? null, to: events[events.length - 1]?.at ?? null, events: events.length, portals: {}, boards: [], setAside: {}, formBlocks: {}, formFailedFields: {}, submit: {} };
  const boards = new Map<string, Analysis["boards"][number]>();
  const starts = new Map<string, { cmd: string; at: number }>();
  for (const e of events) {
    const p = (a.portals[e.portal] ??= blank());
    const d = e as Record<string, unknown>;
    switch (e.kind) {
      case "cmd.start":
        bump(p.runs, e.cmd);
        starts.set(e.run, { cmd: e.cmd, at: Date.parse(e.at) });
        break;
      case "cmd.exit": {
        if (num(d.code) !== 0) p.failedRuns++;
        const s = starts.get(e.run);
        if (s) bump(p.minutes, s.cmd, Math.round((Date.parse(e.at) - s.at) / 600) / 100);
        break;
      }
      case "jobspy.query":
        p.jobspy.queries++;
        if (d.ok === false) p.jobspy.failed++;
        p.jobspy.rows += num(d.rows);
        p.jobspy.kept += num(d.kept);
        break;
      case "freehire.call":
        p.freehire.calls++;
        if (d.ok === false) p.freehire.failed++;
        p.freehire.returned += num(d.returned);
        p.freehire.kept += num(d.kept);
        break;
      case "board.read": {
        p.boards.reads++;
        if (d.ok === false) p.boards.failed++;
        p.boards.open += num(d.open);
        p.boards.kept += num(d.kept);
        const key = `${str(d.ats)}:${str(d.slug).toLowerCase()}`;
        const b = boards.get(key) ?? { key, ats: str(d.ats), company: str(d.company), reads: 0, failed: 0, open: 0, kept: 0 };
        b.reads++;
        if (d.ok === false) b.failed++;
        b.open = Math.max(b.open, num(d.open));
        b.kept += num(d.kept);
        boards.set(key, b);
        break;
      }
      case "hourly.boards":
        p.hourlyFresh += num(d.fresh);
        break;
      case "job.added":
        bump(p.added, str(d.source).split(/[:+ ]/)[0] || "unknown");
        break;
      case "job.status": {
        bump(p.transitions, `${str(d.from)} → ${str(d.to)}`);
        if (d.to === "applied") p.applied++;
        if (d.to === "submission_unknown") p.unconfirmed++;
        if (["needs_review", "skipped", "failed", "blocked", "login_required"].includes(str(d.to)) && d.reason) bump(a.setAside, `${str(d.to)}: ${str(d.reason).slice(0, 90)}`);
        break;
      }
      case "apply.pick":
        if (d.dry !== true) p.picked += Array.isArray(d.picked) ? d.picked.length : 0;
        if (d.notPicked && typeof d.notPicked === "object") for (const [k, v] of Object.entries(d.notPicked as Count)) bump(p.notPicked, k, num(v));
        break;
      case "lock.take":
        if (num(d.waitedMs) > 0) p.lockWaits++;
        p.lockWaitMs += num(d.waitedMs);
        break;
      case "lock.gaveup":
        p.lockGaveUp++;
        break;
      case "easyapply.summary":
        if (d.dry !== true) p.easyApplied += Array.isArray(d.applied) ? d.applied.length : 0;
        break;
      case "form.outcome":
        if (d.action !== "send" && d.action !== "applied") bump(a.formBlocks, `${str(d.action)}: ${str(d.reason).slice(0, 90) || "no reason given"}`);
        if (Array.isArray(d.failed)) for (const f of d.failed as { label?: unknown }[]) bump(a.formFailedFields, str(f.label).slice(0, 80) || "(no label)");
        if (Array.isArray(d.missingRequired)) for (const m of d.missingRequired as unknown[]) bump(a.formFailedFields, `required: ${str(m).slice(0, 70)}`);
        break;
      case "submit.result":
        bump(a.submit, str(d.state) || "unknown");
        break;
    }
  }
  a.boards = [...boards.values()];
  return a;
}

/** The analysis as lines a person reads: per portal, then what to look at. */
export function printAnalysis(a: Analysis, rows = 12): string[] {
  const out: string[] = [];
  out.push(`Events ${a.events}, from ${a.from ?? "-"} to ${a.to ?? "-"}`);
  for (const [name, p] of Object.entries(a.portals).sort()) {
    out.push("", `== ${name}`);
    out.push(`  runs: ${top(p.runs, 10).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}${p.failedRuns ? `  (${p.failedRuns} ended with an error)` : ""}`);
    const mins = top(p.minutes, 5).map(([k, v]) => `${k} ${Math.round(v / Math.max(1, p.runs[k] ?? 1))} min avg`);
    if (mins.length) out.push(`  time: ${mins.join(", ")}`);
    out.push(`  Indeed + LinkedIn: ${p.jobspy.queries} queries (${p.jobspy.failed} failed), ${p.jobspy.rows} rows, ${p.jobspy.kept} kept`);
    out.push(`  freehire: ${p.freehire.calls} calls (${p.freehire.failed} failed), ${p.freehire.returned} postings, ${p.freehire.kept} kept`);
    out.push(`  employer boards: ${p.boards.reads} reads (${p.boards.failed} failed), ${p.boards.kept} postings fit; ${p.hourlyFresh} were new in an hourly run`);
    out.push(`  jobs added by source: ${top(p.added, 8).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    out.push(`  sent: ${p.applied} confirmed, ${p.unconfirmed} clicked but unconfirmed, ${p.easyApplied} through Easy Apply; ${p.picked} picked by the apply pass`);
    if (Object.keys(p.notPicked).length) out.push(`  not picked from Last 12 hours: ${top(p.notPicked, 6).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (p.lockWaits || p.lockGaveUp) out.push(`  waited for the browser ${p.lockWaits} time(s), ${Math.round(p.lockWaitMs / 60_000)} min in all; gave up ${p.lockGaveUp} time(s)`);
    out.push(`  status changes: ${top(p.transitions, 8).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  }
  const yielding = a.boards.filter((b) => b.kept > 0).sort((x, y) => y.kept - x.kept).slice(0, rows);
  if (yielding.length) out.push("", "Boards that gave the most postings that fit:", ...yielding.map((b) => `  ${String(b.kept).padStart(4)}  ${b.company} (${b.ats})`));
  const dead = a.boards.filter((b) => b.failed === b.reads && b.reads >= 2).slice(0, rows);
  if (dead.length) out.push("", "Boards that failed every read (check or drop them):", ...dead.map((b) => `  ${b.company} (${b.ats}) ${b.reads} reads`));
  const quiet = a.boards.filter((b) => b.kept === 0 && b.failed < b.reads && b.reads >= 3).length;
  if (quiet) out.push("", `${quiet} boards answered but never had a posting that fit.`);
  if (Object.keys(a.setAside).length) out.push("", "Why jobs were set aside:", ...top(a.setAside, rows).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`));
  if (Object.keys(a.formBlocks).length) out.push("", "What stopped a filled form from being sent:", ...top(a.formBlocks, rows).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`));
  if (Object.keys(a.formFailedFields).length) out.push("", "Fields the tool could not set most often:", ...top(a.formFailedFields, rows).map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`));
  if (Object.keys(a.submit).length) out.push("", `After the click: ${top(a.submit, 6).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return out;
}
