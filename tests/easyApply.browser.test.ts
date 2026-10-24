/**
 * LinkedIn's Easy Apply dialog, in a real Chrome. The application is the dialog on the posting,
 * not a page of its own: its controls are read, and the posting's own search box is not.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Page, closeTab, sleep, type Target } from "../src/browser/cdp.js";
import { dump, install } from "../src/browser/session.js";
import { isApplicationForm } from "../src/forms/fields.js";
import { pickSubmit } from "../src/browser/report.js";
import { BROWSER, childEnv } from "../src/config.js";
import { startEasyApplyPages, type EasyApplyPages } from "./helpers/easyApplyPages.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe.skipIf(!existsSync(BROWSER.chromePath))("a LinkedIn Easy Apply dialog", () => {
  let chrome: ChildProcess;
  let port = 0;
  let profile = "";
  let pages: EasyApplyPages;

  const open = async (name: string): Promise<Page> => {
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json()) as Target;
    const page = await Page.attach(target);
    await page.navigate(`${pages.origin}${name}`);
    await sleep(300);
    await install(page);
    return page;
  };

  beforeAll(async () => {
    port = await freePort();
    profile = mkdtempSync(path.join(tmpdir(), "jev-easy-apply-"));
    pages = await startEasyApplyPages();
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

  it("marks the dialog, reads only its controls, and treats it as the application", async () => {
    const page = await open("/contact.html");
    try {
      const d = await dump(page);
      expect(d.easyApply).toBe(true);
      expect(isApplicationForm(d)).toBe(true);
      const labels = d.fields.map((f) => f.label);
      expect(labels).toContain("Email address");
      expect(labels).toContain("Mobile phone number");
      expect(labels).not.toContain("Search");
    } finally {
      page.close();
      await closeTab(page.targetId).catch(() => undefined);
    }
  }, 20_000);

  it("finds the submit control on the review step", async () => {
    const page = await open("/review.html");
    try {
      const d = await dump(page);
      expect(d.easyApply).toBe(true);
      expect(pickSubmit(d.submitSelectors)?.text).toBe("Submit application");
    } finally {
      page.close();
      await closeTab(page.targetId).catch(() => undefined);
    }
  }, 20_000);

  it("leaves a sign-in dialog alone", async () => {
    const page = await open("/sign-in.html");
    try {
      const d = await dump(page);
      expect(d.easyApply).toBe(false);
      expect(isApplicationForm(d)).toBe(false);
    } finally {
      page.close();
      await closeTab(page.targetId).catch(() => undefined);
    }
  }, 20_000);
});
