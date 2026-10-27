import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupSession, clearLoginRequired, linkedinGate, loginRequiredPath, markLoginRequired, pauseLinkedin, quarantinedGenerations, readLoginRequired, readPaused, restoreSessionIfMissing, resumeLinkedin, sessionStatus } from "../src/run/linkedinSession.js";

const bases: string[] = [];
const dirs = () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "jev-linkedin-session-"));
  bases.push(base);
  return { base, auth: path.join(base, "auth"), backup: path.join(base, "backup"), data: path.join(base, "data") };
};
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** A complete saved session. Only what the checks read is written. */
function writeSession(auth: string, over: { cookies?: unknown; sourceState?: boolean | { created_at?: string; login_generation?: string }; profile?: "empty" | "missing" | "full" } = {}): void {
  mkdirSync(auth, { recursive: true });
  if (over.cookies !== undefined) writeFileSync(path.join(auth, "cookies.json"), JSON.stringify(over.cookies));
  else writeFileSync(path.join(auth, "cookies.json"), JSON.stringify([{ name: "li_at", value: "made-up" }, { name: "bcookie", value: "made-up" }]));
  if (over.sourceState !== false) writeFileSync(path.join(auth, "source-state.json"), JSON.stringify({ version: 1, ...(typeof over.sourceState === "object" ? over.sourceState : {}) }));
  if (over.profile !== "missing") {
    mkdirSync(path.join(auth, "profile"), { recursive: true });
    if (over.profile !== "empty") writeFileSync(path.join(auth, "profile", "Preferences"), "{}");
  }
}

describe("the saved LinkedIn session", () => {
  it("is missing when there is no cookies.json", () => {
    const d = dirs();
    expect(sessionStatus(d.auth)).toEqual({ ok: false, reason: "cookies.json is missing" });
  });

  it("is not usable without the li_at cookie", () => {
    const d = dirs();
    writeSession(d.auth, { cookies: [{ name: "bcookie", value: "made-up" }] });
    expect(sessionStatus(d.auth)).toEqual({ ok: false, reason: "no li_at cookie in cookies.json" });
  });

  it("accepts a cookie list wrapped in an object", () => {
    const d = dirs();
    writeSession(d.auth, { cookies: { cookies: [{ name: "li_at", value: "made-up" }] } });
    expect(sessionStatus(d.auth)).toEqual({ ok: true, reason: null });
  });

  it("is not usable without source-state.json", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: false });
    expect(sessionStatus(d.auth)).toEqual({ ok: false, reason: "source-state.json is missing" });
  });

  it("is not usable with an empty browser profile", () => {
    const d = dirs();
    writeSession(d.auth, { profile: "empty" });
    expect(sessionStatus(d.auth)).toEqual({ ok: false, reason: "the browser profile is empty" });
  });

  it("is not usable with no browser profile", () => {
    const d = dirs();
    writeSession(d.auth, { profile: "missing" });
    expect(sessionStatus(d.auth)).toEqual({ ok: false, reason: "the browser profile is missing" });
  });

  it("is usable when all three parts are there", () => {
    const d = dirs();
    writeSession(d.auth);
    expect(sessionStatus(d.auth)).toEqual({ ok: true, reason: null });
  });
});

describe("the known-good copy", () => {
  it("copies the cookies, the source metadata and the profile, replacing an older copy", () => {
    const d = dirs();
    writeSession(d.auth);
    mkdirSync(path.join(d.backup, "profile"), { recursive: true });
    writeFileSync(path.join(d.backup, "profile", "Old"), "stale");
    writeFileSync(path.join(d.backup, "cookies.json"), "[]");

    expect(backupSession(d.auth, d.backup)).toBe(true);

    expect(readFileSync(path.join(d.backup, "cookies.json"), "utf8")).toContain("li_at");
    expect(existsSync(path.join(d.backup, "source-state.json"))).toBe(true);
    expect(readFileSync(path.join(d.backup, "profile", "Preferences"), "utf8")).toBe("{}");
    expect(existsSync(path.join(d.backup, "profile", "Old"))).toBe(false);
  });

  it("backs up nothing when a live part is missing", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: false });
    expect(backupSession(d.auth, d.backup)).toBe(false);
    expect(existsSync(d.backup)).toBe(false);
  });

  it("restores the copy when the live cookies are gone", () => {
    const d = dirs();
    writeSession(d.auth);
    expect(backupSession(d.auth, d.backup)).toBe(true);
    rmSync(path.join(d.auth, "cookies.json"));
    rmSync(path.join(d.auth, "source-state.json"));
    rmSync(path.join(d.auth, "profile"), { recursive: true });

    expect(restoreSessionIfMissing(d.auth, d.backup)).toBe(true);
    expect(sessionStatus(d.auth)).toEqual({ ok: true, reason: null });
  });

  it("never overwrites live cookies, even when they are a revoked session", () => {
    const d = dirs();
    writeSession(d.auth);
    expect(backupSession(d.auth, d.backup)).toBe(true);
    writeSession(d.auth, { cookies: [{ name: "li_at", value: "a-newer-session" }] });
    const live = readFileSync(path.join(d.auth, "cookies.json"), "utf8");

    expect(restoreSessionIfMissing(d.auth, d.backup)).toBe(false);
    expect(readFileSync(path.join(d.auth, "cookies.json"), "utf8")).toBe(live);
  });

  it("restores nothing when the copy has no li_at cookie", () => {
    const d = dirs();
    writeSession(d.auth);
    expect(backupSession(d.auth, d.backup)).toBe(true);
    writeFileSync(path.join(d.backup, "cookies.json"), JSON.stringify([{ name: "bcookie", value: "made-up" }]));
    rmSync(path.join(d.auth, "cookies.json"));

    expect(restoreSessionIfMissing(d.auth, d.backup)).toBe(false);
    expect(existsSync(path.join(d.auth, "cookies.json"))).toBe(false);
  });
});

describe("the login-required flag", () => {
  it("round-trips through the file and is cleared again", () => {
    const d = dirs();
    expect(loginRequiredPath(d.data)).toBe(path.join(d.data, "login-required.json"));
    expect(readLoginRequired(d.data)).toBeNull();

    markLoginRequired("no li_at cookie in cookies.json", d.data);
    expect(readLoginRequired(d.data)).toMatchObject({ reason: "no li_at cookie in cookies.json" });
    expect(typeof readLoginRequired(d.data)?.at).toBe("string");

    clearLoginRequired(d.data);
    expect(readLoginRequired(d.data)).toBeNull();
    // Clearing a flag that is already gone is not an error.
    expect(() => clearLoginRequired(d.data)).not.toThrow();
  });

  it("reads a malformed flag as no flag", () => {
    const d = dirs();
    mkdirSync(d.data, { recursive: true });
    writeFileSync(path.join(d.data, "login-required.json"), JSON.stringify({ reason: "no at" }));
    expect(readLoginRequired(d.data)).toBeNull();
    writeFileSync(path.join(d.data, "login-required.json"), "not json");
    expect(readLoginRequired(d.data)).toBeNull();
  });
});

/** What the fork leaves when it rejects a login: the session moved into an invalid-state folder. */
function quarantine(auth: string, generation: string): void {
  const dir = path.join(auth, `invalid-state-2026-10-25T01-00-00Z-${generation.slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source-state.json"), JSON.stringify({ version: 1, created_at: "2026-10-25T00:00:00Z", login_generation: generation }));
}

describe("a login the fork already moved aside", () => {
  it("is named by the generation of each invalid-state folder, and nothing else is read from it", () => {
    const d = dirs();
    quarantine(d.auth, "aaaaaaaa-1");
    quarantine(d.auth, "bbbbbbbb-2");
    mkdirSync(path.join(d.auth, "profile"), { recursive: true });
    expect([...quarantinedGenerations(d.auth)].sort()).toEqual(["aaaaaaaa-1", "bbbbbbbb-2"]);
    expect(quarantinedGenerations(path.join(d.base, "nowhere")).size).toBe(0);
  });

  it("is not put back from the backup, so the dead session cannot loop", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: { created_at: "2026-10-25T00:00:00Z", login_generation: "dead-login" } });
    expect(backupSession(d.auth, d.backup)).toBe(true);
    rmSync(path.join(d.auth, "cookies.json"));
    quarantine(d.auth, "dead-login");

    expect(restoreSessionIfMissing(d.auth, d.backup)).toBe(false);
    expect(existsSync(path.join(d.auth, "cookies.json"))).toBe(false);
  });

  it("still lets a backup of a different login come back", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: { created_at: "2026-10-25T00:00:00Z", login_generation: "good-login" } });
    expect(backupSession(d.auth, d.backup)).toBe(true);
    rmSync(path.join(d.auth, "cookies.json"));
    quarantine(d.auth, "some-older-login");

    expect(restoreSessionIfMissing(d.auth, d.backup)).toBe(true);
  });
});

describe("whether the fork may be asked at all", () => {
  const gateDirs = (d: ReturnType<typeof dirs>) => ({ authRoot: d.auth, backupRoot: d.backup, dataDir: d.data });

  it("says yes for a usable session and no flag", () => {
    const d = dirs();
    writeSession(d.auth);
    expect(linkedinGate(gateDirs(d))).toEqual({ ok: true });
  });

  it("restores a good backup when the live session is gone", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: { created_at: "2026-10-25T00:00:00Z", login_generation: "good-login" } });
    backupSession(d.auth, d.backup);
    rmSync(path.join(d.auth, "cookies.json"));
    expect(linkedinGate(gateDirs(d))).toEqual({ ok: true });
  });

  it("says no, unflagged, when the live session is gone and the backup is a dead login", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: { created_at: "2026-10-25T00:00:00Z", login_generation: "dead-login" } });
    backupSession(d.auth, d.backup);
    rmSync(path.join(d.auth, "cookies.json"));
    quarantine(d.auth, "dead-login");
    expect(linkedinGate(gateDirs(d))).toEqual({ ok: false, reason: "cookies.json is missing", flagged: false });
  });

  it("says no while a flag stands and the session is not newer than it", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: { created_at: "2026-10-25T00:00:00Z", login_generation: "old-login" } });
    markLoginRequired("Sign in", d.data);
    const gate = linkedinGate(gateDirs(d));
    expect(gate).toMatchObject({ ok: false, flagged: true });
    expect((gate as { reason: string }).reason).toMatch(/LinkedIn login required since .*: Sign in\. Run: node bin\/jev\.js session relogin/);
    expect(readLoginRequired(d.data)).not.toBeNull();
  });

  it("does not restore a backup while a flag stands", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: { created_at: "2026-10-25T00:00:00Z", login_generation: "good-login" } });
    backupSession(d.auth, d.backup);
    rmSync(path.join(d.auth, "cookies.json"));
    markLoginRequired("Sign in", d.data);
    expect(linkedinGate(gateDirs(d))).toMatchObject({ ok: false, flagged: true });
    expect(existsSync(path.join(d.auth, "cookies.json"))).toBe(false);
  });

  it("lifts the flag when the saved session is a newer login", () => {
    const d = dirs();
    markLoginRequired("Sign in", d.data);
    writeSession(d.auth, { sourceState: { created_at: new Date(Date.now() + 60_000).toISOString(), login_generation: "new-login" } });
    expect(linkedinGate(gateDirs(d))).toEqual({ ok: true });
    expect(readLoginRequired(d.data)).toBeNull();
  });

  it("reads the cookie file's own time when the fork wrote no login time", () => {
    const d = dirs();
    writeSession(d.auth);
    const flagAt = new Date(Date.now() - 3_600_000).toISOString();
    mkdirSync(d.data, { recursive: true });
    writeFileSync(loginRequiredPath(d.data), JSON.stringify({ at: flagAt, reason: "Sign in" }));
    expect(linkedinGate(gateDirs(d))).toEqual({ ok: true });
  });
});

describe("pausing the LinkedIn MCP", () => {
  it("round-trips through one file and is undone again", () => {
    const d = dirs();
    const file = path.join(d.base, "paused.json");
    expect(readPaused(file)).toBeNull();
    pauseLinkedin(file, new Date("2026-10-26T13:00:00Z"));
    expect(readPaused(file)).toEqual({ at: "2026-10-26T13:00:00.000Z" });
    resumeLinkedin(file);
    expect(readPaused(file)).toBeNull();
    resumeLinkedin(file);
  });

  it("closes the gate even for a good session, and says how to undo it", () => {
    const d = dirs();
    writeSession(d.auth, { sourceState: { created_at: "2026-10-25T00:00:00Z", login_generation: "good-login" } });
    const file = path.join(d.base, "paused.json");
    pauseLinkedin(file);
    const gate = linkedinGate({ authRoot: d.auth, backupRoot: d.backup, dataDir: d.data, pausedFile: file });
    expect(gate).toMatchObject({ ok: false, flagged: true, paused: true });
    expect((gate as { reason: string }).reason).toMatch(/paused since .*session resume/);
    // A pause is not a lost session: it leaves no login flag.
    expect(readLoginRequired(d.data)).toBeNull();
    resumeLinkedin(file);
    expect(linkedinGate({ authRoot: d.auth, backupRoot: d.backup, dataDir: d.data, pausedFile: file })).toEqual({ ok: true });
  });
});
