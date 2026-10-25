import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupSession, clearLoginRequired, loginRequiredPath, markLoginRequired, readLoginRequired, restoreSessionIfMissing, sessionStatus } from "../src/run/linkedinSession.js";

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
function writeSession(auth: string, over: { cookies?: unknown; sourceState?: boolean; profile?: "empty" | "missing" | "full" } = {}): void {
  mkdirSync(auth, { recursive: true });
  if (over.cookies !== undefined) writeFileSync(path.join(auth, "cookies.json"), JSON.stringify(over.cookies));
  else writeFileSync(path.join(auth, "cookies.json"), JSON.stringify([{ name: "li_at", value: "made-up" }, { name: "bcookie", value: "made-up" }]));
  if (over.sourceState !== false) writeFileSync(path.join(auth, "source-state.json"), JSON.stringify({ version: 1 }));
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
