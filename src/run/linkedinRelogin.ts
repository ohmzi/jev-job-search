/**
 * Signing in to LinkedIn again without the person, once per outage. The fork's own `--login` does the
 * signing in: with the credentials file the person made for it, it fills the form itself and falls
 * back to a window when LinkedIn asks for a challenge. This module only starts that command. It never
 * opens the credentials file, never sees the email or the password, and passes neither to anything.
 *
 * It is bounded on purpose. A login that fails, times out or hits a challenge is never repeated by
 * the tool: the person is told and signs in with `session relogin`. A login that worked is followed
 * by a wait before the next automatic one, because a session LinkedIn revokes again at once is not
 * something more logins fix.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { childEnv, LINKEDIN_SESSION, PATHS, ROOT } from "../config.js";
import { scrub } from "../util/redact.js";
import { writeAtomic } from "../util/store.js";
import { notify } from "./assist.js";
import { backupSession, clearLoginRequired, sessionStatus, type SessionDirs } from "./linkedinSession.js";
import { sharedDir } from "./shared.js";

export type ReloginOutcome = "signed_in" | "failed" | "timed_out" | "needs_person" | "not_usable";
export type ReloginResult = { ok: boolean; reason: string; /** The fork's login was started. False when a rule said not to. */ tried: boolean };

const Attempt = z.object({ at: z.string(), outcome: z.enum(["signed_in", "failed", "timed_out", "needs_person", "not_usable"]) });
export type Attempt = z.infer<typeof Attempt>;

/**
 * The words the fork prints when LinkedIn asked for something only a person can do, or when the saved
 * credentials did not finish the sign-in. The fork never prints the email or the password.
 */
export const NEEDS_PERSON = /login requires a person|did not complete the sign-in|did not reach a signed-in page|complete (?:it|the sign-in) in the browser/i;

/** What the fork says when another login or client already holds the shared browser. Nothing was tried, so nothing is counted. */
export const BROWSER_BUSY = /another linkedin mcp client is using the browser/i;

/** Starts the fork's login. Injected in tests so no browser opens. `onLine` hears each line the fork prints. */
export type LoginRunner = (args: string[], o: { timeoutMs: number; personWaitMs: number; cwd: string; onLine: (line: string) => void }) => Promise<{ code: number | null; timedOut: boolean }>;

export const spawnLogin: LoginRunner = (args, o) =>
  new Promise((resolve) => {
    // The allow-listed environment: no key and no password of this tool reaches the fork's login.
    const child = spawn("uv", args, { cwd: o.cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let timer = setTimeout(stop, o.timeoutMs);
    function stop() {
      timedOut = true;
      child.kill("SIGTERM");
    }
    // The window stays open for a person once the fork says it needs one, so the wait is longer from then on.
    let extended = false;
    const heard = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        if (!extended && NEEDS_PERSON.test(text)) {
          extended = true;
          clearTimeout(timer);
          timer = setTimeout(stop, o.personWaitMs);
        }
        o.onLine(text);
      }
    };
    child.stdout.on("data", heard);
    child.stderr.on("data", heard);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });

/** Where the last automatic attempt is kept. It is shared: the four portals use one LinkedIn login. */
export const reloginAttemptFile = () => path.join(sharedDir(), "linkedin-relogin.json");

export function readReloginAttempt(file = reloginAttemptFile()): Attempt | null {
  try {
    const parsed = Attempt.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Forgets the last attempt, so the next outage gets its one try. Called when the person signs in themselves. */
export function clearReloginAttempt(file = reloginAttemptFile()): void {
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export type ReloginOptions = {
  session?: SessionDirs;
  now?: Date;
  log?: (line: string) => void;
  run?: LoginRunner;
  attemptFile?: string;
  /** Where the fork's printed lines are kept, so a failed sign-in can be explained. */
  logFile?: string;
  /** Only its existence is checked. */
  credentialsFile?: string;
};

/**
 * One automatic sign-in, if the rules allow it. `ok` means the saved session is usable again, backed
 * up, and this portal's flag is cleared; the other portals' flags lift on their own because the new
 * login is newer than each. `reason` says what happened or why nothing was tried.
 */
export async function tryRelogin(o: ReloginOptions = {}): Promise<ReloginResult> {
  const cfg = LINKEDIN_SESSION.autoRelogin;
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  if (!cfg.enabled) return { ok: false, tried: false, reason: "automatic sign-in is off" };
  if (!existsSync(o.credentialsFile ?? cfg.credentialsFile)) {
    return { ok: false, tried: false, reason: "there is no credentials file for the fork, so only you can sign in: node bin/jev.js session relogin" };
  }
  const file = o.attemptFile ?? reloginAttemptFile();
  const last = readReloginAttempt(file);
  if (last && last.outcome !== "signed_in") {
    return { ok: false, tried: false, reason: `the automatic sign-in at ${last.at} did not work (${last.outcome.replace("_", " ")}), so it is not repeated. Sign in yourself: node bin/jev.js session relogin` };
  }
  if (last && now.getTime() - Date.parse(last.at) < cfg.minHoursBetween * 3_600_000) {
    return { ok: false, tried: false, reason: `the session was signed in again automatically at ${last.at} and LinkedIn rejected it again within ${cfg.minHoursBetween} hours, so it is not tried again. Sign in yourself: node bin/jev.js session relogin` };
  }

  log("[easy] the LinkedIn session is gone; signing in again with the fork's saved credentials");
  const args = ["run", "--project", LINKEDIN_SESSION.forkDir, "python", "-m", "linkedin_mcp_server", "--login"];
  // What the fork prints is kept (scrubbed) beside the other run files, and the last words that say why
  // LinkedIn wants a person are what the person is told.
  const logFile = o.logFile ?? path.join(PATHS.runs, "linkedin-relogin.log");
  const say = (line: string) => {
    try {
      mkdirSync(path.dirname(logFile), { recursive: true });
      appendFileSync(logFile, `${now.toISOString()} ${scrub(line)}\n`);
    } catch {
      /* the log is a convenience */
    }
  };
  say("--- automatic sign-in started");
  let why: string | null = null;
  let busy = false;
  const onLine = (line: string) => {
    say(line);
    if (BROWSER_BUSY.test(line)) busy = true;
    if (NEEDS_PERSON.test(line)) {
      const first = why === null;
      why = scrub(line).slice(0, 200);
      if (first) notify("LinkedIn needs you", `${why} The window is open on your screen.`);
    }
  };
  const result = await (o.run ?? spawnLogin)(args, { timeoutMs: cfg.timeoutMs, personWaitMs: cfg.personWaitMs, cwd: ROOT, onLine });
  // A login window that is already open (the person's own, or another client's) holds the browser. The fork
  // refused to start a second one, so nothing was tried: the one allowance is not spent and the next run asks again.
  if (busy) return { ok: false, tried: false, reason: "a LinkedIn login window or another client already holds the browser, so no second sign-in was started. If a window is open on your screen, finish the sign-in there" };
  const record = (outcome: ReloginOutcome) => writeAtomic(file, JSON.stringify({ at: now.toISOString(), outcome }) + "\n");
  const detail = why ? ` LinkedIn said: ${why}` : "";
  if (result.timedOut) {
    record(why ? "needs_person" : "timed_out");
    return { ok: false, tried: true, reason: `${why ? "LinkedIn asked for something only you can do and the window was not finished in time." : "the fork's sign-in printed nothing and did not finish in time."}${detail} Output: ${logFile}. Sign in yourself: node bin/jev.js session relogin` };
  }
  if (result.code !== 0) {
    record("failed");
    return { ok: false, tried: true, reason: `the fork's sign-in ended with ${result.code === null ? "no exit code" : `exit ${result.code}`}.${detail} Output: ${logFile}. Sign in yourself: node bin/jev.js session relogin` };
  }
  const state = sessionStatus(o.session?.authRoot);
  if (!state.ok) {
    record("not_usable");
    return { ok: false, tried: true, reason: `the fork's sign-in finished but the saved session is not usable: ${state.reason}. Sign in yourself: node bin/jev.js session relogin` };
  }
  backupSession(o.session?.authRoot, o.session?.backupRoot);
  clearLoginRequired(o.session?.dataDir);
  record("signed_in");
  log("[easy] signed in to LinkedIn again; the session is backed up and the login flag is cleared");
  return { ok: true, tried: true, reason: "signed in again" };
}
