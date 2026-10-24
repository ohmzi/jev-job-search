/**
 * A form that writes "Required" after a question instead of setting the HTML attribute, as
 * TeamViewer's does. The dumper must still treat the field as required, or a required salary
 * box is left empty and the site refuses the send after the click.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, closeTab, sleep, type Target } from "../src/browser/cdp.js";
import { dump, install } from "../src/browser/session.js";
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

describe.skipIf(!existsSync(BROWSER.chromePath))("a question that says Required after its words", () => {
  let chrome: ChildProcess;
  let port = 0;
  let profile = "";
  let pages: ProtectionPages;

  beforeAll(async () => {
    port = await freePort();
    profile = mkdtempSync(path.join(tmpdir(), "jev-required-"));
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

  it("marks the field and the group as required, and leaves an optional one alone", async () => {
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(target);
    try {
      await page.navigate(`${pages.origin}/required-label.html`);
      await sleep(500);
      await install(page);
      const d = await dump(page);
      const salary = d.fields.find((f) => /salary expectations/i.test(f.label));
      const visa = d.fields.find((f) => /visa sponsorship/i.test(f.label));
      const middle = d.fields.find((f) => /middle name/i.test(f.label));
      expect(salary?.required).toBe(true);
      expect(visa?.required).toBe(true);
      expect(middle?.required).toBe(false);
    } finally {
      page.close();
      await closeTab(page.targetId).catch(() => undefined);
    }
  }, 20_000);
});
