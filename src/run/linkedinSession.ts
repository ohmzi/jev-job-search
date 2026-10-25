/**
 * The LinkedIn session the local fork keeps. Before the fork is asked anything, the saved
 * session is checked here: a missing or revoked cookie is a login the person has to do, not a
 * call that would open a login window nobody is watching. A copy of a session that worked is
 * kept aside, and a run that needs a login leaves a flag the dashboard shows.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LINKEDIN_SESSION, PATHS } from "../config.js";
import { writeAtomic } from "../util/store.js";

export type SessionStatus = { ok: boolean; reason: string | null };
export type LoginRequired = { at: string; reason: string };

const COOKIES = "cookies.json";
const SOURCE_STATE = "source-state.json";
const PROFILE = "profile";

/** The cookies in a cookies file, as an array or as `{ cookies: [] }`. Null when it cannot be read as either. */
function cookieList(file: string): unknown[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { cookies?: unknown }).cookies)) return (raw as { cookies: unknown[] }).cookies;
  return null;
}

/** Whether a cookies file holds LinkedIn's session cookie. */
function hasLiAt(file: string): boolean {
  const list = cookieList(file);
  return !!list?.some((cookie) => !!cookie && typeof cookie === "object" && (cookie as { name?: unknown }).name === "li_at");
}

/**
 * Whether the fork can use the saved session: a readable cookies file with `li_at` in it, the
 * source metadata beside it, and a browser profile that is not empty. The reason names the first
 * thing that is missing, so a run says what the person has to fix.
 */
export function sessionStatus(authRoot = LINKEDIN_SESSION.authRoot): SessionStatus {
  const cookies = path.join(authRoot, COOKIES);
  if (!existsSync(cookies)) return { ok: false, reason: "cookies.json is missing" };
  const list = cookieList(cookies);
  if (!list) return { ok: false, reason: "cookies.json is not a cookie list" };
  if (!hasLiAt(cookies)) return { ok: false, reason: "no li_at cookie in cookies.json" };
  if (!existsSync(path.join(authRoot, SOURCE_STATE))) return { ok: false, reason: "source-state.json is missing" };
  const profile = path.join(authRoot, PROFILE);
  if (!existsSync(profile) || !statSync(profile).isDirectory()) return { ok: false, reason: "the browser profile is missing" };
  try {
    if (!readdirSync(profile).length) return { ok: false, reason: "the browser profile is empty" };
  } catch {
    return { ok: false, reason: "the browser profile cannot be read" };
  }
  return { ok: true, reason: null };
}

/** Copies one file or folder over its old copy at the destination. */
function replace(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true });
  else cpSync(src, dest);
}

/**
 * Keeps the live session as the known-good copy. All three parts have to be there: a partial
 * copy would restore a session the fork cannot use. Returns false when anything is missing.
 */
export function backupSession(authRoot = LINKEDIN_SESSION.authRoot, backupRoot = LINKEDIN_SESSION.backupRoot): boolean {
  for (const name of [COOKIES, SOURCE_STATE, PROFILE]) {
    if (!existsSync(path.join(authRoot, name))) return false;
  }
  mkdirSync(backupRoot, { recursive: true });
  for (const name of [COOKIES, SOURCE_STATE, PROFILE]) replace(path.join(authRoot, name), path.join(backupRoot, name));
  return true;
}

/**
 * Puts the backing copy back, but only when the live cookies file is gone. A live file is never
 * overwritten: a session LinkedIn revoked must not come back over a newer one. The backup's own
 * cookies must hold `li_at`, or there is nothing worth restoring.
 */
export function restoreSessionIfMissing(authRoot = LINKEDIN_SESSION.authRoot, backupRoot = LINKEDIN_SESSION.backupRoot): boolean {
  const live = path.join(authRoot, COOKIES);
  if (existsSync(live)) return false;
  const saved = path.join(backupRoot, COOKIES);
  if (!existsSync(saved) || !hasLiAt(saved)) return false;
  mkdirSync(authRoot, { recursive: true });
  for (const name of [COOKIES, SOURCE_STATE, PROFILE]) {
    const src = path.join(backupRoot, name);
    if (existsSync(src)) replace(src, path.join(authRoot, name));
  }
  return true;
}

/** The file a run leaves when the fork cannot run without the person. */
export function loginRequiredPath(dataDir = PATHS.data): string {
  return path.join(dataDir, "login-required.json");
}

/** Says on the dashboard that the session needs the person, and why. */
export function markLoginRequired(reason: string, dataDir = PATHS.data): void {
  writeAtomic(loginRequiredPath(dataDir), JSON.stringify({ at: new Date().toISOString(), reason }) + "\n");
}

/** Clears the flag. A missing file is already clear. */
export function clearLoginRequired(dataDir = PATHS.data): void {
  try {
    unlinkSync(loginRequiredPath(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** The flag as written, or null when there is none or it cannot be read. */
export function readLoginRequired(dataDir = PATHS.data): LoginRequired | null {
  try {
    const raw = JSON.parse(readFileSync(loginRequiredPath(dataDir), "utf8")) as { at?: unknown; reason?: unknown };
    if (typeof raw.at !== "string" || typeof raw.reason !== "string") return null;
    return { at: raw.at, reason: raw.reason };
  } catch {
    return null;
  }
}
