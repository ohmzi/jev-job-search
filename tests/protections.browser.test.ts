/**
 * The challenge adapters in a real Chrome, against stand-in walls served from this machine.
 * The click is a real CDP mouse press, so this proves the part the scripted tests cannot: the
 * press lands inside the provider's frame and the token is read back from the page afterwards.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, closeTab, sleep, type Target } from "../src/browser/cdp.js";
import { passProtections, protectionSignal, readProtection } from "../src/browser/protections.js";
import { install } from "../src/browser/session.js";
import { BROWSER, childEnv } from "../src/config.js";
import { startProtectionPages, type ProtectionPages } from "./helpers/protectionServer.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!existsSync(BROWSER.chromePath))("a challenge in a real browser", () => {
  let chrome: ChildProcess;
  let port = 0;
  let profile = "";
  let pages: ProtectionPages;

  const open = async (file: string): Promise<Page> => {
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(target);
    // Each fixture starts from a clean jar: a cookie one wall set must not explain the next one.
    await page.send("Network.clearBrowserCookies");
    await page.navigate(`${pages.origin}/${file}`);
    await sleep(500);
    await install(page);
    return page;
  };

  const close = async (page: Page) => {
    page.close();
    await closeTab(page.targetId).catch(() => undefined);
  };

  beforeAll(async () => {
    port = await freePort();
    profile = mkdtempSync(path.join(tmpdir(), "jev-protections-"));
    pages = await startProtectionPages();
    chrome = spawn(BROWSER.chromePath, ["--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore", env: childEnv() });
    for (let i = 0; i < 80; i++) {
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) return;
      await sleep(250);
    }
    throw new Error("headless Chrome did not start");
  }, 30_000);

  afterAll(async () => {
    chrome?.kill();
    await pages?.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  });

  it("presses the reCAPTCHA checkbox once and reads the response back", async () => {
    const page = await open("protection-recaptcha.html");
    try {
      const reading = await readProtection(page);
      expect(protectionSignal(reading)).toMatchObject({ provider: "recaptcha", blocking: true });
      const result = await passProtections(page, { timeoutMs: 4_000 });
      expect(result).toMatchObject({ passed: true, needsHuman: false, provider: "recaptcha" });
      expect(await page.evaluate<number>("window.__clicks || 0")).toBe(1);
      expect(await page.evaluate<string>('document.querySelector(\'textarea[name="g-recaptcha-response"]\').value')).toBe("test-response");
    } finally {
      await close(page);
    }
  }, 20_000);

  it("presses the Turnstile checkbox once and reads its token", async () => {
    const page = await open("protection-turnstile.html");
    try {
      const reading = await readProtection(page);
      expect(protectionSignal(reading)).toMatchObject({ provider: "turnstile", blocking: true });
      const result = await passProtections(page, { timeoutMs: 4_000 });
      expect(result).toMatchObject({ passed: true, needsHuman: false, provider: "turnstile" });
      expect(await page.evaluate<number>("window.__clicks || 0")).toBe(1);
      expect(await page.evaluate<string>('document.querySelector(\'textarea[name="cf-turnstile-response"]\').value')).toBe("test-token");
    } finally {
      await close(page);
    }
  }, 20_000);

  it("hands a widget that never answers to the person, after one click", async () => {
    const page = await open("protection-silent.html");
    try {
      const result = await passProtections(page, { timeoutMs: 500, pollMs: 25 });
      expect(result).toMatchObject({ passed: false, needsHuman: true, provider: "recaptcha" });
      expect(await page.evaluate<number>("window.__clicks || 0")).toBe(1);
    } finally {
      await close(page);
    }
  }, 20_000);

  it("presses a checkbox that is below the fold where the pointer can reach it", async () => {
    const page = await open("protection-below-fold.html");
    try {
      const reading = await readProtection(page);
      expect(protectionSignal(reading)).toMatchObject({ provider: "recaptcha", blocking: true });
      const result = await passProtections(page, { timeoutMs: 4_000 });
      expect(result).toMatchObject({ passed: true, provider: "recaptcha" });
      expect(await page.evaluate<number>("window.__clicks || 0")).toBe(1);
      expect(await page.evaluate<string>('document.querySelector(\'textarea[name="g-recaptcha-response"]\').value')).toBe("test-response");
    } finally {
      await close(page);
    }
  }, 20_000);

  it("waits out a managed Cloudflare page without pressing its frame", async () => {
    const page = await open("protection-managed.html");
    try {
      const reading = await readProtection(page);
      expect(protectionSignal(reading).provider).toBe("turnstile");
      const result = await passProtections(page, { reading, timeoutMs: 0 });
      expect(result).toMatchObject({ passed: false, needsHuman: true, provider: "turnstile" });
      expect(await page.evaluate<number>("window.__clicks || 0")).toBe(0);
    } finally {
      await close(page);
    }
  }, 20_000);

  it("reads a DataDome wall and presses nothing", async () => {
    const page = await open("protection-datadome.html");
    try {
      const reading = await readProtection(page);
      expect(protectionSignal(reading).provider).toBe("datadome");
      const result = await passProtections(page, { reading, timeoutMs: 0 });
      expect(result).toMatchObject({ passed: false, needsHuman: true, provider: "datadome" });
    } finally {
      await close(page);
    }
  }, 20_000);

  it("reads an Akamai denial page and presses nothing", async () => {
    const page = await open("protection-akamai.html");
    try {
      const reading = await readProtection(page);
      expect(protectionSignal(reading).provider).toBe("akamai");
      const result = await passProtections(page, { reading, timeoutMs: 0 });
      expect(result).toMatchObject({ passed: false, needsHuman: true, provider: "akamai" });
    } finally {
      await close(page);
    }
  }, 20_000);
});
