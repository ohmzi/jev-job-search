/**
 * The LinkedIn session the local fork keeps. Before the fork is asked anything, the saved
 * session is checked here: a missing or revoked cookie is a login the person has to do, not a
 * call that would open a login window nobody is watching. A copy of a session that worked is
 * kept aside, and a run that needs a login leaves a flag the dashboard shows.
 *
 * The flag also stops the next run. LinkedIn revokes a session now and then, and the fork answers a
 * revoked one by moving it aside (`invalid-state-*`). A backup of that same session must never be put
 * back, and no call may be made while the flag stands, or every run would restore the dead session,
 * ask the fork, and have it moved aside again.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LINKEDIN_SESSION, PATHS } from "../config.js";
import { writeAtomic } from "../util/store.js";
import { sharedDir } from "./shared.js";

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

/** The login the fork wrote beside a saved session: when it was made and which login it is. */
function sourceState(dir: string): { createdAt: string | null; generation: string | null } {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, SOURCE_STATE), "utf8")) as { created_at?: unknown; login_generation?: unknown };
    return { createdAt: typeof raw.created_at === "string" ? raw.created_at : null, generation: typeof raw.login_generation === "string" ? raw.login_generation : null };
  } catch {
    return { createdAt: null, generation: null };
  }
}

/** The logins the fork has already moved aside as revoked. Only their identity is read, never their cookies. */
export function quarantinedGenerations(authRoot = LINKEDIN_SESSION.authRoot): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(authRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.startsWith("invalid-state-")) continue;
    const { generation } = sourceState(path.join(authRoot, name));
    if (generation) out.add(generation);
  }
  return out;
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
 * cookies must hold `li_at`, and its login must not be one the fork has already moved aside, or
 * there is nothing worth restoring.
 */
export function restoreSessionIfMissing(authRoot = LINKEDIN_SESSION.authRoot, backupRoot = LINKEDIN_SESSION.backupRoot): boolean {
  const live = path.join(authRoot, COOKIES);
  if (existsSync(live)) return false;
  const saved = path.join(backupRoot, COOKIES);
  if (!existsSync(saved) || !hasLiAt(saved)) return false;
  // A backup of a login the fork already moved aside is a revoked session. Putting it back would only
  // have the fork reject it and move it aside again.
  const { generation } = sourceState(backupRoot);
  if (generation && quarantinedGenerations(authRoot).has(generation)) return false;
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

export type SessionDirs = { authRoot?: string; backupRoot?: string; dataDir?: string; pausedFile?: string };
export type Gate = { ok: true } | { ok: false; reason: string; flagged: boolean; paused?: boolean };

/**
 * The switch that pauses every use of the LinkedIn MCP: the Easy Apply step, the link lookups and the
 * apply pass. It is one file shared by the four portals, so one command pauses them all.
 */
export const pausedFile = () => path.join(sharedDir(), "linkedin-paused.json");

export type Paused = { at: string };

export function readPaused(file = pausedFile()): Paused | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown };
    return typeof raw.at === "string" ? { at: raw.at } : null;
  } catch {
    return null;
  }
}

export function pauseLinkedin(file = pausedFile(), now = new Date()): void {
  writeAtomic(file, JSON.stringify({ at: now.toISOString() }) + "\n");
}

export function resumeLinkedin(file = pausedFile()): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Whether the fork may be asked anything. Never while it is paused. While a run's login flag stands the answer is no, until
 * the person signs in again: the saved session is newer than the flag. With no flag, a missing
 * session is restored from the backup when that backup is not a revoked login, and a session that is
 * still not usable is a no.
 */
export function linkedinGate(dirs: SessionDirs = {}): Gate {
  const paused = readPaused(dirs.pausedFile);
  if (paused) return { ok: false, reason: `the LinkedIn MCP is paused since ${paused.at}. Resume: node bin/jev.js session resume`, flagged: true, paused: true };
  const authRoot = dirs.authRoot ?? LINKEDIN_SESSION.authRoot;
  const backupRoot = dirs.backupRoot ?? LINKEDIN_SESSION.backupRoot;
  const flag = readLoginRequired(dirs.dataDir);
  if (flag) {
    // When the login was made: the fork writes it beside the session; an older fork leaves the cookie file's own time.
    const created = sessionStatus(authRoot).ok ? sourceState(authRoot).createdAt ?? statSync(path.join(authRoot, COOKIES)).mtime.toISOString() : null;
    const signedInSince = !!created && Date.parse(created) > Date.parse(flag.at);
    if (!signedInSince) return { ok: false, reason: `LinkedIn login required since ${flag.at}: ${flag.reason}. Run: node bin/jev.js session relogin`, flagged: true };
    clearLoginRequired(dirs.dataDir);
  }
  restoreSessionIfMissing(authRoot, backupRoot);
  const state = sessionStatus(authRoot);
  if (!state.ok) return { ok: false, reason: state.reason ?? "the saved session is not usable", flagged: false };
  return { ok: true };
}
