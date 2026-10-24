/**
 * The Playwright stealth evasions on a tab the tool opens: the browser is started by the tool,
 * so it outlives the command, and Playwright's extra stealth is applied to each new page.
 * Skipped where Chrome is not installed, like the other browser tests.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, sleep, type Target } from "../src/browser/cdp.js";
import { openStealthTab } from "../src/browser/stealthPlaywright.js";
import { BROWSER, childEnv } from "../src/config.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!existsSync(BROWSER.chromePath))("a tab opened with Playwright stealth", () => {
  let chrome: ChildProcess;
  let port = 0;
  let profile = "";

  beforeAll(async () => {
    port = await freePort();
    profile = mkdtempSync(path.join(tmpdir(), "jev-pwstealth-"));
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

  it("carries the plugin's evasions before its first page script runs", async () => {
    const { targetId, ...stealth } = await openStealthTab(`http://127.0.0.1:${port}`, "about:blank");
    const target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[]).find((t) => t.id === targetId);
    expect(target).toBeDefined();
    const page = await Page.attach({ ...(target as Target), stealth });
    try {
      await page.navigate("data:text/html,<html><body>ready</body></html>");
      await sleep(600);
      const seen = await page.call<{ vendor: string | null; renderer: string | null; userAgent: string; webdriver: boolean }>(`async function () {
        const gl = document.createElement("canvas").getContext("webgl");
        const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
        return {
          vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
          renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
          userAgent: navigator.userAgent,
          webdriver: navigator.webdriver,
        };
      }`);
      // The plugin's own tell: a headless window reports Google/SwiftShader and a HeadlessChrome UA.
      expect(seen.vendor).toBe("Intel Inc.");
      expect(seen.userAgent).not.toMatch(/HeadlessChrome/);
      expect(seen.webdriver).toBe(false);
    } finally {
      page.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => undefined);
    }
  }, 30_000);
});
