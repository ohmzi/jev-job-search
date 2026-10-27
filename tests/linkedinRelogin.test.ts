import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINKEDIN_SESSION } from "../src/config.js";
import { notify } from "../src/run/assist.js";
import { clearReloginAttempt, readReloginAttempt, spawnLogin, tryRelogin, type LoginRunner } from "../src/run/linkedinRelogin.js";
import { markLoginRequired, readLoginRequired, sessionStatus } from "../src/run/linkedinSession.js";

vi.mock("../src/run/assist.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/run/assist.js")>()), notify: vi.fn() }));

const bases: string[] = [];
function setup() {
  const base = mkdtempSync(path.join(os.tmpdir(), "jev-relogin-"));
  bases.push(base);
  const dirs = { authRoot: path.join(base, "auth"), backupRoot: path.join(base, "backup"), dataDir: path.join(base, "data") };
  mkdirSync(dirs.authRoot, { recursive: true });
  const credentialsFile = path.join(base, "credentials.env");
  // Only its existence is ever checked, so the test file holds no credential, made up or not.
  writeFileSync(credentialsFile, "");
  return { base, dirs, credentialsFile, attemptFile: path.join(base, "attempt.json"), logFile: path.join(base, "relogin.log") };
}
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** What the fork's login leaves when it works. */
function writeFreshSession(authRoot: string): void {
  mkdirSync(path.join(authRoot, "profile"), { recursive: true });
  writeFileSync(path.join(authRoot, "profile", "Preferences"), "{}");
  writeFileSync(path.join(authRoot, "cookies.json"), JSON.stringify([{ name: "li_at", value: "made-up" }]));
  writeFileSync(path.join(authRoot, "source-state.json"), JSON.stringify({ version: 1, created_at: new Date().toISOString(), login_generation: "fresh-login" }));
}

const worked = (authRoot: string): LoginRunner & { calls: { args: string[] }[] } => {
  const calls: { args: string[] }[] = [];
  const run: LoginRunner = async (args) => {
    calls.push({ args });
    writeFreshSession(authRoot);
    return { code: 0, timedOut: false };
  };
  return Object.assign(run, { calls });
};

describe("signing in to LinkedIn again on its own", () => {
  it("starts the fork's own login, then backs the session up and clears the flag", async () => {
    const t = setup();
    markLoginRequired("Sign in", t.dirs.dataDir);
    const run = worked(t.dirs.authRoot);
    const result = await tryRelogin({ session: t.dirs, run, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-26T10:00:00Z") });

    expect(result).toMatchObject({ ok: true, tried: true });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.args).toEqual(["run", "--project", LINKEDIN_SESSION.forkDir, "python", "-m", "linkedin_mcp_server", "--login"]);
    expect(sessionStatus(t.dirs.authRoot).ok).toBe(true);
    expect(existsSync(path.join(t.dirs.backupRoot, "cookies.json"))).toBe(true);
    expect(readLoginRequired(t.dirs.dataDir)).toBeNull();
    expect(readReloginAttempt(t.attemptFile)).toEqual({ at: "2026-10-26T10:00:00.000Z", outcome: "signed_in" });
  });

  it("does nothing without a credentials file", async () => {
    const t = setup();
    rmSync(t.credentialsFile);
    const run = worked(t.dirs.authRoot);
    const result = await tryRelogin({ session: t.dirs, run, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile });
    expect(result).toMatchObject({ ok: false, tried: false });
    expect(result.reason).toMatch(/no credentials file/);
    expect(run.calls).toEqual([]);
  });

  it("is not repeated after a login that failed, until the person signs in themselves", async () => {
    const t = setup();
    let calls = 0;
    const failing: LoginRunner = async () => (calls++, { code: 1, timedOut: false });
    const first = await tryRelogin({ session: t.dirs, run: failing, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-26T10:00:00Z") });
    expect(first).toMatchObject({ ok: false, tried: true });
    expect(readReloginAttempt(t.attemptFile)?.outcome).toBe("failed");

    const second = await tryRelogin({ session: t.dirs, run: failing, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-27T10:00:00Z") });
    expect(second).toMatchObject({ ok: false, tried: false });
    expect(calls).toBe(1);

    // The person signs in with `session relogin`, which forgets the attempt.
    clearReloginAttempt(t.attemptFile);
    await tryRelogin({ session: t.dirs, run: failing, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-28T10:00:00Z") });
    expect(calls).toBe(2);
  });

  it("treats a login that timed out like one that failed", async () => {
    const t = setup();
    const slow: LoginRunner = async () => ({ code: null, timedOut: true });
    const result = await tryRelogin({ session: t.dirs, run: slow, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile });
    expect(result).toMatchObject({ ok: false, tried: true });
    expect(readReloginAttempt(t.attemptFile)?.outcome).toBe("timed_out");
  });

  it("does not take a clean exit for a session when the saved session is still unusable", async () => {
    const t = setup();
    const empty: LoginRunner = async () => ({ code: 0, timedOut: false });
    const result = await tryRelogin({ session: t.dirs, run: empty, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile });
    expect(result).toMatchObject({ ok: false, tried: true });
    expect(result.reason).toMatch(/not usable: cookies\.json is missing/);
    expect(readReloginAttempt(t.attemptFile)?.outcome).toBe("not_usable");
  });

  it("waits after a login that worked, so a session LinkedIn revokes at once is not logged in again and again", async () => {
    const t = setup();
    const run = worked(t.dirs.authRoot);
    await tryRelogin({ session: t.dirs, run, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-26T10:00:00Z") });
    rmSync(path.join(t.dirs.authRoot, "cookies.json"));

    const soon = await tryRelogin({ session: t.dirs, run, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-26T12:00:00Z") });
    expect(soon).toMatchObject({ ok: false, tried: false });
    expect(run.calls).toHaveLength(1);

    const later = await tryRelogin({ session: t.dirs, run, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-26T17:00:00Z") });
    expect(later).toMatchObject({ ok: true, tried: true });
    expect(run.calls).toHaveLength(2);
    expect(readFileSync(t.attemptFile, "utf8")).toContain("17:00:00");
  });

  it("keeps what the fork printed, and says what LinkedIn asked for when it needs a person", async () => {
    const t = setup();
    vi.mocked(notify).mockClear();
    const asking: LoginRunner = async (_args, o) => {
      o.onLine("Opening browser for LinkedIn login...");
      o.onLine("Login requires a person: a security check. The browser window is open; complete it there.");
      return { code: null, timedOut: true };
    };
    const result = await tryRelogin({ session: t.dirs, run: asking, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile, now: new Date("2026-10-26T10:00:00Z") });

    expect(result).toMatchObject({ ok: false, tried: true });
    expect(result.reason).toContain("LinkedIn said: Login requires a person: a security check");
    expect(result.reason).toContain(t.logFile);
    expect(readReloginAttempt(t.attemptFile)?.outcome).toBe("needs_person");
    const log = readFileSync(t.logFile, "utf8");
    expect(log).toContain("Opening browser for LinkedIn login...");
    expect(log).toContain("Login requires a person: a security check");
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(notify).mock.calls[0]?.[1])).toContain("Login requires a person");
  });

  it("is signed in when the person finishes the check inside the extra time", async () => {
    const t = setup();
    const finished: LoginRunner = async (_args, o) => {
      o.onLine("Login requires a person: a security check. The browser window is open; complete it there.");
      writeFreshSession(t.dirs.authRoot);
      return { code: 0, timedOut: false };
    };
    const result = await tryRelogin({ session: t.dirs, run: finished, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile });
    expect(result).toMatchObject({ ok: true, tried: true });
    expect(readReloginAttempt(t.attemptFile)?.outcome).toBe("signed_in");
  });

  it("puts the fork's last words in the reason of a login that ended badly, with secrets scrubbed from the log", async () => {
    const t = setup();
    const bad: LoginRunner = async (_args, o) => {
      o.onLine("Saved credentials did not complete the sign-in; complete it in the browser window.");
      o.onLine("redirected to https://www.linkedin.com/checkpoint?token=made-up-secret-value");
      return { code: 1, timedOut: false };
    };
    const result = await tryRelogin({ session: t.dirs, run: bad, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile });
    expect(result.reason).toContain("exit 1");
    expect(result.reason).toContain("Saved credentials did not complete the sign-in");
    expect(readFileSync(t.logFile, "utf8")).not.toContain("made-up-secret-value");
  });
});

describe("a login window that is already open", () => {
  it("is not a failed try: nothing is recorded and the person is not told off", async () => {
    const t = setup();
    vi.mocked(notify).mockClear();
    const busy: LoginRunner = async (_args, o) => {
      o.onLine("LinkedIn MCP Server - Profile Creation");
      o.onLine("Profile creation failed: Another LinkedIn MCP client is using the browser, so a login cannot start. Close it and try again.");
      return { code: 1, timedOut: false };
    };
    const result = await tryRelogin({ session: t.dirs, run: busy, attemptFile: t.attemptFile, logFile: t.logFile, credentialsFile: t.credentialsFile });

    expect(result).toMatchObject({ ok: false, tried: false });
    expect(result.reason).toMatch(/already holds the browser/);
    expect(existsSync(t.attemptFile)).toBe(false);
    expect(vi.mocked(notify)).not.toHaveBeenCalled();
    expect(readFileSync(t.logFile, "utf8")).toContain("Another LinkedIn MCP client");
  });
});

describe("the process that runs the fork's login", () => {
  /** A stand-in `uv` first on the PATH, so the real spawn runs without a browser. */
  function fakeUv(script: string): () => void {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-fake-uv-"));
    bases.push(dir);
    writeFileSync(path.join(dir, "uv"), `#!/bin/sh\n${script}\n`);
    chmodSync(path.join(dir, "uv"), 0o755);
    const before = process.env.PATH;
    process.env.PATH = `${dir}:${before}`;
    return () => {
      process.env.PATH = before;
    };
  }

  it("hears every line and reports the exit code", async () => {
    const restore = fakeUv('echo "Opening browser for LinkedIn login..."\necho "a warning" 1>&2\nexit 0');
    try {
      const lines: string[] = [];
      const result = await spawnLogin(["run"], { timeoutMs: 5_000, personWaitMs: 5_000, cwd: os.tmpdir(), onLine: (l) => lines.push(l) });
      expect(result).toEqual({ code: 0, timedOut: false });
      expect(lines.sort()).toEqual(["Opening browser for LinkedIn login...", "a warning"]);
    } finally {
      restore();
    }
  });

  it("stops a login that prints nothing at the first limit", async () => {
    const restore = fakeUv("exec sleep 30");
    try {
      const started = Date.now();
      const result = await spawnLogin(["run"], { timeoutMs: 300, personWaitMs: 5_000, cwd: os.tmpdir(), onLine: () => {} });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      restore();
    }
  });

  it("waits longer once the fork says it needs a person", async () => {
    const restore = fakeUv('echo "Login requires a person: a security check. The browser window is open; complete it there."\nexec sleep 30');
    try {
      const started = Date.now();
      const result = await spawnLogin(["run"], { timeoutMs: 300, personWaitMs: 1_200, cwd: os.tmpdir(), onLine: () => {} });
      const took = Date.now() - started;
      expect(result.timedOut).toBe(true);
      expect(took).toBeGreaterThanOrEqual(1_000);
      expect(took).toBeLessThan(4_000);
    } finally {
      restore();
    }
  });
});
