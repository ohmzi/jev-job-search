/**
 * The dashboard server: serves the page and the records from your own machine, and takes what
 * the page sends: a status change, an answer to an open question, your daily policy, the
 * schedule. It listens on localhost only, answers only its own page, and takes a change only with
 * the token it gave that page when it started.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { confirmLearned, loadLearned } from "../answers/learned.js";
import { DAILY, EVENTS, isCombinedBoard, PATHS, REPORT, reportPublicOrigins } from "../config.js";
import { loadQueue, mutateQueue, Response as ReplyKind, RUN_OWNED, updateEntry } from "../jobs/queue.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import { loadDaily, localDay, requestStop, stopRequested } from "../run/daily.js";
import { settleReview } from "../run/inbox.js";
import { loadPolicy, Policy } from "../run/policy.js";
import { installSchedule, nextRun, removeSchedule, scheduleStatus } from "../run/schedule.js";
import { currentRun, withStore, writeAtomic } from "../util/store.js";
import { buildReport, StatusChange } from "./data.js";
import { buildRecent } from "./recent.js";
import { combineData, combineNeeds, forward, hasLinkKey, isLinkedPath, portalsBut, readPortal, readPortalEvents, Routed, type Portal } from "./link.js";
import { eventContext, readEvents } from "../log/events.js";
import { buildNeeds, saveAnswers, showForm, Stale } from "./needs.js";
import { reportPage } from "./page.js";

/** Applies one change from the page: the queue entry and the record row both move. A job a live run is working on is refused. */
export function applyStatusChange(c: StatusChange, files: { queue?: string; rows?: string } = {}): { company: string; title: string } {
  return withStore(() => {
    const e = mutateQueue((q) => {
      const was = q.entries.find((x) => x.job.id === c.id);
      if (c.status && was && RUN_OWNED.includes(was.status) && currentRun()) throw new Busy(`a run is working on ${was.job.company} right now`);
      // The page may be old: a status is changed only from the one the person was looking at.
      if (c.status && was && c.was !== undefined && c.was !== was.status) throw new Busy(`${was.job.company} changed since this page was loaded. Nothing was changed. Reload the page.`);
      return updateEntry(q, c.id, {
        // A status the person chose is final: the hourly sweep must not age this job out again.
        ...(c.status ? { status: c.status, statusReason: c.reason ?? null, waitingFor: null, holdUntil: null } : {}),
        ...(c.notes !== undefined ? { notes: c.notes } : {}),
        ...(c.status === "applied" ? { appliedAt: new Date().toISOString() } : {}),
      });
    }, files.queue);
    saveRows(upsertEntry(loadRows(files.rows), e, c.notes !== undefined ? { Notes: c.notes } : {}), files.rows);
    return { company: e.job.company, title: e.job.title };
  });
}

/** A change that cannot be made now because a run owns the job. */
export class Busy extends Error {}

/** What the Automation screen shows: the policy, the fixed limits, the schedule and its next run, and today's runs. */
export function automation(now = new Date()) {
  const schedule = scheduleStatus();
  let policy: Policy | null = null;
  let policyError = "";
  try {
    policy = loadPolicy();
  } catch (err) {
    policyError = err instanceof Error ? err.message : String(err);
  }
  return {
    policy,
    policyError,
    defaults: Policy.parse({}),
    limits: { maxTarget: DAILY.maxTarget, perBoard: DAILY.perBoard, perEmployerPerDay: DAILY.perEmployerPerDay, gapMinutes: DAILY.gapMs.map((ms) => ms / 60_000), maxMinutes: DAILY.maxMinutes },
    schedule: { on: schedule.installed && schedule.loaded, at: schedule.at ?? DAILY.at, next: schedule.installed && schedule.at ? (nextRun(schedule.at, now)?.toISOString() ?? null) : null },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    today: loadDaily(localDay(now)),
    /** True while a daily run is working, and whether it was asked to stop after its current application. */
    running: (currentRun()?.command ?? "").startsWith("daily"),
    stopAsked: stopRequested(),
  };
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.on("data", (d: Buffer) => {
      body += d.toString();
      if (body.length > 100_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

/** Sends a body, gzipped when the browser takes it: the combined board's records run to megabytes and the page reads them every minute. */
const send = (res: ServerResponse, status: number, type: string, body: string) => {
  const zip = body.length > 1024 && /\bgzip\b/.test(String(res.req?.headers["accept-encoding"] ?? ""));
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", vary: "accept-encoding", ...(zip ? { "content-encoding": "gzip" } : {}) });
  res.end(zip ? gzipSync(body) : body);
};

/**
 * True for a request from the dashboard's own page: the Host is this server on this machine or a
 * public origin the person configured, and a request that names where it came from (every POST
 * from a browser does) names one of those too.
 */
export function fromThisPage(req: Pick<IncomingMessage, "headers">, port: number, publicOrigins: readonly string[] = reportPublicOrigins()): boolean {
  const here = [`127.0.0.1:${port}`, `localhost:${port}`];
  const publicUrls = publicOrigins.flatMap((o) => {
    try {
      const u = new URL(o);
      return [{ host: u.host, origin: u.origin }];
    } catch {
      return [];
    }
  });
  const hosts = new Set([...here, ...publicUrls.map((u) => u.host)].map((h) => h.toLowerCase()));
  if (!hosts.has(String(req.headers.host ?? "").toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const origins = new Set([...here.map((h) => `http://${h}`), ...publicUrls.map((u) => u.origin)].map((o) => o.toLowerCase()));
  return origins.has(String(origin).toLowerCase());
}

/** True when a request carries the token this server gave its page. */
export function hasToken(req: Pick<IncomingMessage, "headers">, token: string): boolean {
  const given = Buffer.from(String(req.headers["x-jev-token"] ?? ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const Answers = z.object({ id: z.string().min(1).max(64), answers: z.array(z.object({ question: z.string().min(1).max(700), answer: z.string().min(1).max(4000), remember: z.boolean().default(false) })).min(1).max(30) });
const ConfirmAnswer = z.object({ id: z.string().min(1).max(64), answer: z.string().trim().min(1, "type the answer before saving it").max(4000) });
const Show = z.object({ id: z.string().min(1).max(64) });
const Schedule = z.object({ on: z.boolean(), at: z.string().max(5).optional() });
const MailAnswer = z.object({ id: z.string().min(1).max(128), jobId: z.string().max(64).optional(), kind: ReplyKind.optional() });

/** A started dashboard: where it listens, the token it gave its page, and how to stop it. */
export type ReportServer = { address: string; token: string; close: () => Promise<void> };

/** The token and the two files a test may point elsewhere. Without them the server makes its own token and uses the real files. */
export type ReportServerOptions = { token?: string; learned?: string; profile?: string; portals?: Portal[] };

/** Starts the server and returns it, so a test can point it at made-up files and stop it again. */
export function createReportServer(port: number, o: ReportServerOptions = {}): Promise<ReportServer> {
  const token = o.token ?? randomBytes(24).toString("hex");
  // With port 0 the machine picks one: the Host check must then use the port it picked.
  let boundPort = port;
  const json = (res: ServerResponse, body: unknown, status = 200) => send(res, status, "application/json", JSON.stringify(body));
  const combined = isCombinedBoard();
  const portals = o.portals ?? portalsBut(port);
  const readAll = () => Promise.all(portals.map((p) => readPortal(p)));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Only this machine's own page may talk to the server: a web page elsewhere must not be able to read the records or change anything.
      if (!fromThisPage(req, boundPort)) return send(res, 403, "text/plain", "forbidden");
      if (req.method === "GET") {
        if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", reportPage(null, token, boundPort));
        // The combined board has no records of its own: it reads the four portals' dashboards.
        if (combined && url.pathname === "/api/data") return json(res, combineData(await readAll()));
        if (combined && url.pathname === "/api/needs") return json(res, combineNeeds(await readAll()));
        if (combined && url.pathname === "/api/automation") return send(res, 404, "text/plain", "the combined board runs nothing");
        if (url.pathname === "/api/events") {
          // A portal serves its own event log; the combined board serves its own and the four portals', each naming its portal.
          const days = Math.max(1, Math.min(EVENTS.keepDays, Number(url.searchParams.get("days")) || EVENTS.serveDays));
          const withSay = url.searchParams.get("say") === "1";
          const own = readEvents(days).filter((e) => withSay || e.kind !== "say");
          if (!combined) return json(res, { portal: eventContext().portal, events: own });
          const parts = await Promise.all(portals.map((p) => readPortalEvents(p, days, withSay)));
          const events = [...own, ...parts.flatMap((p) => p.events)].sort((a, b) => a.at.localeCompare(b.at));
          return json(res, { portals: parts.map((p) => ({ portal: p.portal, port: p.port, events: p.events.length, error: p.error })), events });
        }
        if (url.pathname === "/api/data") {
          const entries = loadQueue().entries;
          return json(res, { ...buildReport(loadRows(), new Date(), buildRecent(entries), new Set(entries.map((e) => e.job.id))), run: currentRun() });
        }
        if (url.pathname === "/api/needs") return json(res, buildNeeds(loadQueue().entries));
        if (url.pathname === "/api/automation") return json(res, automation());
        return send(res, 404, "text/plain", "not found");
      }
      if (req.method !== "POST") return send(res, 405, "text/plain", "not allowed");
      // A change needs the token the page was given, as JSON: a form on another site can send neither.
      // The combined board's change for a job here carries the dashboards' shared secret instead,
      // and only for the paths a portal's own page could have sent it on (never its daily rules).
      const fromPage = hasToken(req, token);
      if (!fromPage && !(!combined && isLinkedPath(url.pathname) && hasLinkKey(req))) return send(res, 403, "text/plain", "forbidden");
      if (!/^application\/json/.test(String(req.headers["content-type"] ?? ""))) return send(res, 415, "text/plain", "send JSON");
      const body: unknown = JSON.parse(await readBody(req));
      // The combined board changes nothing itself: a change goes to the portal that owns the job.
      if (combined) {
        if (!isLinkedPath(url.pathname)) return json(res, { error: "the combined board runs nothing; change this on the portal's own page" }, 400);
        const r = Routed.safeParse(body);
        if (!r.success || !portals.some((p) => p.port === r.data.port)) return json(res, { error: "say which portal the job is in" }, 400);
        const { port: to, ...change } = r.data;
        const answer = await forward(to, url.pathname, change);
        console.log(`passed to the portal on port ${to}: ${url.pathname} → ${answer.status}`);
        return json(res, answer.body, answer.status);
      }
      const bad = (e: z.ZodError) => json(res, { error: e.issues.map((i) => i.message).join("; ") }, 400);
      if (url.pathname === "/api/status") {
        const p = StatusChange.safeParse(body);
        if (!p.success) return bad(p.error);
        // The page says which status it was showing, so an old page cannot move a job that has moved on.
        if (p.data.status && p.data.was === undefined) return json(res, { error: "say which status the job had" }, 400);
        const changed = applyStatusChange(p.data);
        console.log(`${changed.company} | ${changed.title} → ${p.data.status ?? "notes"}`);
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/answer") {
        const p = Answers.safeParse(body);
        if (!p.success) return bad(p.error);
        const saved = saveAnswers(p.data.id, p.data.answers);
        console.log(`${saved.company} | ${saved.title} → answered, back in the queue${saved.kept ? ` (${saved.kept} kept for other forms)` : ""}`);
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/confirm-answer") {
        const p = ConfirmAnswer.safeParse(body);
        if (!p.success) return bad(p.error);
        // The page may be old: an answer that is no longer waiting is refused with words, not a stack trace.
        if (!loadLearned(o.learned).pending.some((row) => row.id === p.data.id)) return json(res, { error: "That answer is no longer waiting. Reload the page." }, 404);
        const kept = confirmLearned(p.data.id, p.data.answer, { ...(o.learned ? { pending: o.learned } : {}), ...(o.profile ? { profile: o.profile } : {}) });
        console.log(`learned answer confirmed: ${kept.question}`);
        return json(res, kept);
      }
      if (url.pathname === "/api/show") {
        const p = Show.safeParse(body);
        if (!p.success) return bad(p.error);
        return json(res, { ok: await showForm(p.data.id) });
      }
      if (url.pathname === "/api/policy") {
        const p = Policy.safeParse(body);
        if (!p.success) return bad(p.error);
        writeAtomic(PATHS.policy, JSON.stringify(p.data, null, 2) + "\n");
        console.log("daily policy saved");
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/schedule") {
        const p = Schedule.safeParse(body);
        if (!p.success) return bad(p.error);
        if (p.data.on) {
          if (!loadPolicy()) return json(res, { error: "save your daily rules first" }, 400);
          const s = installSchedule(p.data.at ?? DAILY.at);
          console.log(`daily run scheduled at ${s.at}`);
        } else {
          removeSchedule();
          console.log("daily run schedule removed");
        }
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/stop") {
        requestStop();
        console.log("the daily run was asked to stop after its current application");
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/mail") {
        const p = MailAnswer.safeParse(body);
        if (!p.success) return bad(p.error);
        return json(res, { ok: settleReview(p.data.id, p.data.jobId && p.data.kind ? { jobId: p.data.jobId, kind: p.data.kind } : null) });
      }
      send(res, 404, "text/plain", "not found");
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, err instanceof Busy || err instanceof Stale ? 409 : 500);
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      boundPort = typeof address === "object" && address ? address.port : port;
      resolve({
        address: `http://127.0.0.1:${boundPort}`,
        token,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

/** Starts the server and returns the address it listens on. */
export async function startReportServer(port: number = REPORT.port, o: ReportServerOptions = {}): Promise<string> {
  return (await createReportServer(port, o)).address;
}
