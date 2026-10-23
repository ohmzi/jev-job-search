/**
 * The stealth bundle in a real Chrome: what a page sees after it is attached and loaded again.
 * Skipped where Chrome is not installed, like the other browser tests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, sleep } from "../src/browser/cdp.js";
import { BROWSER, childEnv } from "../src/config.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const PAGE_SCRIPT = `(async () => {
  const p = await navigator.permissions.query({ name: "notifications" });
  document.body.textContent = [
    String(navigator.webdriver),
    typeof window.chrome,
    navigator.plugins.length,
    navigator.languages.length,
    typeof Notification === "undefined" ? "none" : Notification.permission,
    p.state,
    Object.prototype.hasOwnProperty.call(navigator, "webdriver"),
  ].join("|");
})()`;

describe.skipIf(!existsSync(BROWSER.chromePath))("a page in the runner's Chrome", () => {
  let chrome: ChildProcess;
  let port = 0;
  let profile = "";

  beforeAll(async () => {
    port = await freePort();
    profile = mkdtempSync(path.join(tmpdir(), "jev-stealth-"));
    chrome = spawn(BROWSER.chromePath, ["--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore", env: childEnv() });
    for (let i = 0; i < 80; i++) {
      if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) return;
      await sleep(250);
    }
    throw new Error("headless Chrome did not start");
  }, 30_000);

  afterAll(async () => {
    chrome?.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  });

  it("reads back as a browser a person opened, not one a tool drives", async () => {
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json()) as { id: string; webSocketDebuggerUrl: string; type: string; url: string; title: string };
    const page = await Page.attach(target);
    try {
      await page.navigate(`data:text/html,<html><body><script>${PAGE_SCRIPT}</script></body></html>`);
      await sleep(600);
      const seen = (await page.evaluate<string>("document.body.textContent")).split("|");
      expect(seen[0]).toBe("false");
      expect(seen[1]).toBe("object");
      expect(Number(seen[2])).toBeGreaterThan(0);
      expect(Number(seen[3])).toBeGreaterThan(0);
      // A headless window says notifications are already denied; a person's window says the page may ask.
      expect(seen[4]).toBe("denied");
      expect(seen[5]).toBe("prompt");
      // The bundle's own getter, which is how a page can tell it ran.
      expect(seen[6]).toBe("true");
    } finally {
      page.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
    }
  }, 20_000);
});
