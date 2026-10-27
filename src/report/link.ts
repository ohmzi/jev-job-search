/**
 * The combined board and the portals' dashboards, on one machine. The combined board reads each
 * portal's dashboard as that portal's own page would, puts the four together, and passes a change
 * the person makes back to the portal that owns the job. The portal makes it with its own code and
 * under its own lock, so there is still one writer for each portal's files.
 *
 * A change passed along carries a secret the five dashboards share (reportLinkKeyFile). A portal
 * takes it only with that secret and only for the paths in REPORT.linkedPaths.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { z } from "zod";
import { REPORT, reportLinkKeyFile } from "../config.js";

export const LINK_HEADER = "x-jev-link";

/** The shared secret, made the first time any dashboard needs it. Only one process can make it; the rest read it. */
export function linkKey(file: string = reportLinkKeyFile()): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return readFileSync(file, "utf8").trim();
}

/** True when a request carries the shared secret, compared in constant time. */
export function hasLinkKey(req: Pick<IncomingMessage, "headers">, key: string = linkKey()): boolean {
  const given = Buffer.from(String(req.headers[LINK_HEADER] ?? ""));
  const want = Buffer.from(key);
  return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

/** A path the combined board may pass to a portal. */
export const isLinkedPath = (p: string) => (REPORT.linkedPaths as readonly string[]).includes(p);

export type Portal = { title: string; port: number; accent: string };

/** The portals the combined board reads: every listed board but itself. */
export const portalsBut = (port: number): Portal[] => REPORT.portals.filter((p) => p.port !== port).map(({ title, port, accent }) => ({ title, port, accent }));

// What a portal's dashboard answers. Only the parts the combined board adds up are checked; every
// row is passed through as the portal gave it, with its portal named.
const Row = z.record(z.unknown());
const PortalData = z
  .object({
    rows: z.array(Row),
    totals: z.record(z.number()),
    byStatus: z.record(z.number()),
    byBoard: z.record(z.number()),
    byDay: z.array(z.object({ day: z.string(), applied: z.number() })),
    recent: z.array(Row).default([]),
  })
  .passthrough();
const PortalNeeds = z.record(z.unknown());
export type PortalData = z.infer<typeof PortalData>;

/** One portal's answer, or why there is none. */
export type Part = { portal: Portal; data: PortalData | null; needs: Record<string, unknown> | null; error: string };

async function getJson(port: number, p: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res.json();
}

/** Reads one portal's records and what waits for the person there. A portal that does not answer is shown as such, not hidden. */
export async function readPortal(portal: Portal, timeoutMs: number = REPORT.combineTimeoutMs): Promise<Part> {
  try {
    const [data, needs] = await Promise.all([getJson(portal.port, "/api/data", timeoutMs), getJson(portal.port, "/api/needs", timeoutMs)]);
    return { portal, data: PortalData.parse(data), needs: PortalNeeds.parse(needs), error: "" };
  } catch (err) {
    return { portal, data: null, needs: null, error: err instanceof Error ? err.message : String(err) };
  }
}

const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
  return into;
};
const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
const tag = (p: Portal) => (x: Record<string, unknown>): Record<string, unknown> => ({ ...x, portal: p.title, port: p.port });

/** The four portals' records as one report: every row names its portal, and the totals are the sums. */
export function combineData(parts: Part[], now = new Date()) {
  const ok = parts.filter((x): x is Part & { data: PortalData } => !!x.data);
  const days: Record<string, number> = {};
  for (const x of ok) for (const d of x.data.byDay) days[d.day] = (days[d.day] ?? 0) + d.applied;
  return {
    combined: true,
    portals: parts.map((x) => ({ ...x.portal, ok: !!x.data, error: x.error })),
    rows: ok.flatMap((x) => x.data.rows.map(tag(x.portal))),
    recent: ok.flatMap((x) => x.data.recent.map(tag(x.portal))).sort((a, b) => String(b.found_at ?? "").localeCompare(String(a.found_at ?? ""))),
    totals: ok.reduce((t, x) => add(t, x.data.totals), {} as Record<string, number>),
    byStatus: sorted(ok.reduce((t, x) => add(t, x.data.byStatus), {} as Record<string, number>)),
    byBoard: sorted(ok.reduce((t, x) => add(t, x.data.byBoard), {} as Record<string, number>)),
    byDay: Object.entries(days).sort(([a], [b]) => a.localeCompare(b)).map(([day, applied]) => ({ day, applied })),
    generatedAt: now.toISOString(),
    run: null,
  };
}

/** The lists the combined page knows how to draw. Anything else a portal waits on is named in `elsewhere`, with a way to it. */
const KNOWN_NEEDS = ["waiting", "questions", "unconfirmed", "self", "mail"] as const;

/** What waits for the person across the four portals: every item names its portal. */
export function combineNeeds(parts: Part[]) {
  const out: Record<string, unknown[]> & { elsewhere: { portal: string; port: number; text: string }[] } = { elsewhere: [] };
  for (const k of KNOWN_NEEDS) out[k] = [];
  for (const x of parts) {
    if (!x.needs) continue;
    for (const [k, v] of Object.entries(x.needs)) {
      if ((KNOWN_NEEDS as readonly string[]).includes(k) && Array.isArray(v)) (out[k] as unknown[]).push(...v.map((i) => tag(x.portal)(i as Record<string, unknown>)));
      else if (Array.isArray(v) && v.length) out.elsewhere.push({ portal: x.portal.title, port: x.portal.port, text: `${v.length} ${k.replace(/_/g, " ")} waiting` });
      else if (v && typeof v === "object" && !Array.isArray(v)) {
        const reason = (v as { reason?: unknown }).reason;
        out.elsewhere.push({ portal: x.portal.title, port: x.portal.port, text: `${k.replace(/_/g, " ")} needs you${typeof reason === "string" ? `: ${reason}` : ""}` });
      }
    }
  }
  return out;
}

/** A change from the combined page: the portal it goes to, and the change as the portal's own page would send it. */
export const Routed = z.object({ port: z.number().int().positive() }).passthrough();

/** Passes one change to the portal that owns the job and returns its answer as it gave it. */
export async function forward(port: number, p: string, body: Record<string, unknown>, key: string = linkKey(), timeoutMs: number = REPORT.combineTimeoutMs): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LINK_HEADER]: key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let answer: unknown = null;
  try {
    answer = await res.json();
  } catch {
    answer = { error: `the portal answered ${res.status}` };
  }
  return { status: res.status, body: answer };
}
