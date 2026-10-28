/**
 * The four job boards and the resume each one sends.
 *
 * The tool has one Chrome window and one profile for the person, but five
 * dashboards: a main board that only reads, and four portals that search and
 * apply (Android or Full Stack, New Jersey or Texas). Each portal keeps its own
 * resume, tailored to the roles it looks for and the city it looks in, so a job
 * opened from one portal must get that portal's file and not another's.
 *
 * Which portal a tab belongs to is read from the page's referrer: the
 * dashboards open a posting with a plain link, so a tab opened by clicking a row
 * on jobnja.ohmzhomelab.ca carries that address as its referrer. A link pasted
 * in, or one opened with `page open`, has no referrer; for those the job is
 * looked up in each portal's own records, and a job only one portal holds is
 * that portal's.
 *
 * Nothing here decides an answer. It decides one file: the resume.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PATHS, REPORT } from "./config.js";
import { ProfileSchema, type Profile } from "./profile/schema.js";

export type BoardKey = "android-nj" | "android-tx" | "fullstack-nj" | "fullstack-tx";
export const BOARD_KEYS: BoardKey[] = ["android-nj", "android-tx", "fullstack-nj", "fullstack-tx"];

export type Board = { key: BoardKey; title: string; port: number; url: string; resume: string };

/** The portals, in the order the dashboards list them. The main board is not one of them: it runs nothing. */
export const BOARDS: Board[] = REPORT.portals
  .filter((p) => p.key !== "main")
  .map((p) => ({
    key: p.key as BoardKey,
    title: p.title,
    port: p.port,
    url: p.url,
    resume: path.join(PATHS.documentsDir, "resume", `${p.key}.pdf`),
  }));

/**
 * The board each tab was first seen to come from, kept between commands. A form that sits a hop
 * away from the posting (Apply opens another page, or the tab was reloaded) would otherwise lose
 * the address of the dashboard it started on. Keyed by Chrome's tab id, which survives navigation.
 */
const TAB_BOARDS = path.join(PATHS.runs, "page-boards.json");

function tabBoards(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(TAB_BOARDS, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function rememberBoard(tabId: string, key: BoardKey): void {
  const all = tabBoards();
  all[tabId] = key;
  const keep = Object.entries(all).slice(-50);
  mkdirSync(PATHS.runs, { recursive: true });
  writeFileSync(TAB_BOARDS, JSON.stringify(Object.fromEntries(keep), null, 2));
}

export const rememberedBoard = (tabId: string): Board | null => boardByKey(tabBoards()[tabId] ?? "");

export const boardByKey = (key: string): Board | null =>
  BOARDS.find((b) => b.key === key || b.title.toLowerCase() === key.toLowerCase()) ?? null;

/**
 * The board a page was opened from, by the address in its referrer. A dashboard
 * on this machine (127.0.0.1:7421) and the same dashboard on its own domain are
 * the same board. The main board names no portal, so it answers null.
 */
export function boardFromReferrer(referrer: string): Board | null {
  let u: URL;
  try {
    u = new URL(referrer);
  } catch {
    return null;
  }
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  for (const b of BOARDS) {
    if (local ? b.port === Number(u.port) : new URL(b.url).hostname === u.hostname) return b;
  }
  return null;
}

/** A posting link reduced to what the same posting has in common across boards: its host and path, no query, no slash, no case. */
export function jobKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** One portal's records, or null when it does not answer. */
async function portalRows(board: Board): Promise<{ job_link?: string }[] | null> {
  for (const base of [board.url, `http://127.0.0.1:${board.port}`]) {
    try {
      const res = await fetch(`${base}/api/data`, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { rows?: { job_link?: string }[] };
      return data.rows ?? [];
    } catch {
      // This address did not answer; the next one may.
    }
  }
  return null;
}

/** The boards whose records hold this posting. Empty when no board answers or none holds it. */
export async function boardsHolding(url: string): Promise<Board[]> {
  const want = jobKey(url);
  const answers = await Promise.all(
    BOARDS.map(async (board) => {
      const rows = await portalRows(board);
      return rows && rows.some((r) => r.job_link && jobKey(r.job_link) === want) ? board : null;
    }),
  );
  return answers.filter((b): b is Board => b !== null);
}

/** The board's own copy of the profile (its city, phone and resume), when it has been put here. */
export function boardProfilePath(key: BoardKey): string {
  return path.join(PATHS.data, "boards", `${key}.json`);
}

/**
 * What a board changes about the profile: where the person says they are, the phone there, and the
 * resume that board sends. Everything else (facts, answers, authorization, education) is the one
 * profile's, so correcting an answer once corrects it on every board.
 */
const Override = z.object({
  address: ProfileSchema.shape.address.optional(),
  phone: ProfileSchema.shape.phone.optional(),
  resume: ProfileSchema.shape.resume.optional(),
});

export function boardProfile(key: BoardKey, base: Profile): Profile {
  const file = boardProfilePath(key);
  if (!existsSync(file)) return base;
  const o = Override.parse(JSON.parse(readFileSync(file, "utf8")));
  return ProfileSchema.parse({
    ...base,
    ...(o.address ? { address: o.address } : {}),
    ...(o.phone ? { phone: o.phone } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
  });
}

export type Detected = { board: Board | null; candidates: Board[]; resume: string; why: string };

/**
 * The board for a tab, and the resume that goes with it. `named` is the board
 * the person named; `referrer` is what the page says it was opened from; `url`
 * is the posting, for the lookup fallback; `fallback` is the file to send when
 * no board can be told.
 */
export async function detectBoard(o: {
  named?: string | undefined;
  referrer?: string;
  remembered?: string | undefined;
  url?: string;
  fallback: string;
}): Promise<Detected> {
  const named = o.named ? boardByKey(o.named) : null;
  if (o.named && !named) throw new Error(`No board "${o.named}". The boards are: ${BOARD_KEYS.join(", ")}.`);
  const file = (b: Board) => (existsSync(b.resume) ? b.resume : o.fallback);
  if (named) return { board: named, candidates: [named], resume: file(named), why: "named" };
  const fromRef = boardFromReferrer(o.referrer ?? "");
  if (fromRef) return { board: fromRef, candidates: [fromRef], resume: file(fromRef), why: "opened from its dashboard" };
  const seen = o.remembered ? boardByKey(o.remembered) : null;
  if (seen) return { board: seen, candidates: [seen], resume: file(seen), why: "this tab was opened from that board" };
  if (o.url && /^https?:/i.test(o.url)) {
    const candidates = await boardsHolding(o.url).catch(() => [] as Board[]);
    if (candidates.length === 1) {
      const only = candidates[0] as Board;
      return { board: only, candidates, resume: file(only), why: "its records are only in this board" };
    }
    if (candidates.length > 1) return { board: null, candidates, resume: o.fallback, why: `it is in ${candidates.map((b) => b.title).join(" and ")}` };
  }
  return { board: null, candidates: [], resume: o.fallback, why: "no board could be told from the tab" };
}
