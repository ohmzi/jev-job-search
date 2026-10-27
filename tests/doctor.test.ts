import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/accounts/secrets.js";
import { checkAccounts, checkKey, checkListingServers, checkNode, checkProfile, checkResume, formatChecks, isReadyToRun, nextStep, type Check } from "../src/doctor.js";

const ok = (name: string): Check => ({ name, ok: true, detail: "fine", fix: "" });
const bad = (name: string, fix: string, optional = false): Check => ({ name, ok: false, detail: "missing", fix, optional });

describe("doctor", () => {
  it("accepts Node 22 and newer", () => {
    expect(checkNode("22.16.0").ok).toBe(true);
    expect(checkNode("20.11.1").ok).toBe(false);
  });
  it("wants a key, and never prints it", () => {
    expect(checkKey("").ok).toBe(false);
    // Built at run time, so no key-shaped text sits in the repository.
    const made = `sk-or-v1-${"k".repeat(12)}`;
    const c = checkKey(made);
    expect(c.ok).toBe(true);
    expect(JSON.stringify(c)).not.toContain(made);
    expect(checkKey("").fix).toMatch(/Do not paste the key into a chat/);
  });
  it("reads the example profile and names a missing one", () => {
    const { check, profile } = checkProfile(new URL("../data/profile.example.json", import.meta.url).pathname);
    expect(check.ok).toBe(true);
    expect(profile?.name.first).toBeTruthy();
    expect(checkProfile("/nowhere/profile.json").check).toMatchObject({ ok: false });
    expect(checkResume(null).ok).toBe(false);
  });
  it("names the first thing that blocks a run before anything optional", () => {
    const checks = [ok("Node.js"), bad("Your drafts", "write drafts", true), bad("DeepSeek key", "add the key"), bad("Your profile", "run setup")];
    expect(nextStep(checks)).toBe("add the key");
    expect(isReadyToRun(checks)).toBe(false);
    expect(formatChecks(checks)).toContain("Next step: add the key");
  });
  it("is ready when only optional things are missing, and still suggests them", () => {
    const checks = [ok("Node.js"), bad("Job queue", "run discover", true)];
    expect(isReadyToRun(checks)).toBe(true);
    expect(nextStep(checks)).toBe("run discover");
    expect(nextStep([ok("Node.js")])).toMatch(/Everything is in place/);
  });
  it("names the fork it will start, and says when the fork is not there", () => {
    const found = checkListingServers({ has: () => true, isDirectory: () => true, exists: () => false });
    expect(found.ok).toBe(true);
    expect(found.optional).toBe(true);
    expect(found.detail).toContain("/linkedin-mcp-server");
    const missing = checkListingServers({ has: () => true, isDirectory: () => false, exists: () => false });
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("/linkedin-mcp-server");
    expect(missing.fix).toContain("/linkedin-mcp-server");
  });
  it("reports whether the fork's profile table names this folder", () => {
    const table = (projects: Record<string, unknown>) => JSON.stringify({ projects });
    const named = checkListingServers({ has: () => true, isDirectory: () => true, exists: () => true, read: () => table({ "jev-android-tx": { phone: "555-0100", resume: "Example_Resume" } }), folder: "jev-android-tx" });
    expect(named.ok).toBe(true);
    expect(named.detail).toContain("applies as that identity");
    const other = checkListingServers({ has: () => true, isDirectory: () => true, exists: () => true, read: () => table({ "another-project": { phone: "555-0100", resume: "Example_Resume" } }), folder: "jev-android-tx" });
    expect(other.ok).toBe(true);
    expect(other.detail).toContain("default identity");
    // A table that is absent, unreadable or malformed changes nothing: the row still passes on the default.
    const absent = checkListingServers({ has: () => true, isDirectory: () => true, exists: () => false });
    expect(absent.ok).toBe(true);
    expect(absent.detail).not.toMatch(/null/);
    const malformed = checkListingServers({ has: () => true, isDirectory: () => true, exists: () => true, read: () => "not json" });
    expect(malformed.ok).toBe(true);
    expect(malformed.detail).toContain("default identity");
  });
  it("treats job-board accounts as optional, and says how each part works", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-doctor-"));
    const files = { accounts: path.join(dir, "accounts.json"), gmail: path.join(dir, "gmail.json") };
    const store = new MemoryStore();
    expect(checkAccounts(store, files)).toMatchObject({ ok: true, optional: true, detail: expect.stringMatching(/not set up/) });
    writeFileSync(files.accounts, JSON.stringify({ providers: { workday: { email: "candidate@example.com", mode: "create_if_missing", emailVerification: true, agreements: ["account_terms"] } } }));
    // No password is needed from the person: new accounts get one made for them. Gmail is optional too.
    expect(checkAccounts(store, files)).toMatchObject({ ok: true, detail: expect.stringMatching(/you click each verification link/) });
    writeFileSync(files.gmail, JSON.stringify({ clientId: "1234567890-fake.apps.googleusercontent.com", email: "candidate@example.com", connectedAt: "2026-10-03T00:00:00Z" }));
    store.values.set("gmail-refresh-token", "1//fake-refresh-token-0123456789");
    const ready = checkAccounts(store, files);
    expect(ready.detail).toMatch(/read from Gmail/);
    expect(JSON.stringify(ready)).not.toMatch(/fake-refresh/);
    writeFileSync(files.accounts, JSON.stringify({ enabled: false, accounts: [{ id: "workday:acme", provider: "workday", tenant: "acme", allowedOrigins: ["https://acme.wd5.myworkdayjobs.com"], email: "candidate@example.com", mode: "existing_only" }] }));
    expect(checkAccounts(store, files).detail).toMatch(/switched off/);
  });
});
