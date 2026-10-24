/**
 * The cookie banner in front of an employer's Apply button, in a real Chrome. OneTrust covers
 * the first Apply control, so a plain click lands on the overlay and the tool reports no form.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, closeTab, sleep, type Target } from "../src/browser/cdp.js";
import { dismissConsent } from "../src/browser/consent.js";
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

const APPLY = "^\\s*(apply|apply now)\\s*$";

describe.skipIf(!existsSync(BROWSER.chromePath))("a cookie banner over the Apply button", () => {
  let chrome: ChildProcess;
  let port = 0;
  let profile = "";
  let pages: ProtectionPages;

  const open = async (): Promise<Page> => {
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(target);
    await page.navigate(`${pages.origin}/consent-overlay.html`);
    await sleep(500);
    await install(page);
    return page;
  };

  beforeAll(async () => {
    port = await freePort();
    profile = mkdtempSync(path.join(tmpdir(), "jev-consent-"));
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

  it("picks the uncovered Apply control, not the one behind the overlay", async () => {
    const page = await open();
    try {
      const point = await page.awj<{ x: number; y: number; ok: boolean }>("clickByText", APPLY);
      expect(point.ok).toBe(true);
      expect(point.x).toBeGreaterThan(400);
    } finally {
      page.close();
      await closeTab(page.targetId).catch(() => undefined);
    }
  }, 20_000);

  it("dismisses the banner with its least-permissive choice, and the form opens", async () => {
    const page = await open();
    try {
      expect(await dismissConsent(page)).toBe(true);
      expect(await page.evaluate<boolean>("window.__rejected === true")).toBe(true);
      expect(await page.evaluate<boolean>("document.getElementById('overlay') === null")).toBe(true);
      const point = await page.awj<{ x: number; y: number; ok: boolean }>("clickByText", APPLY);
      expect(point.ok).toBe(true);
      await page.click(point.x, point.y);
      await sleep(300);
      expect(await page.evaluate<boolean>("document.getElementById('form').style.display === 'block'")).toBe(true);
    } finally {
      page.close();
      await closeTab(page.targetId).catch(() => undefined);
    }
  }, 20_000);
});
