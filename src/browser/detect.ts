/**
 * What a protected page can read about the window the tool drives. The probe runs inside the
 * page, so it reports what a challenge widget sees, not what the browser was told at launch.
 * A finding is something a bot score is likely to count against the window; the doctor prints
 * them, and the fixes live in stealth.ts.
 */
import { closeTab, ensureBrowser, newTab, Page } from "./cdp.js";

export type Fingerprint = {
  webdriver: boolean;
  userAgent: string;
  chromeObject: boolean;
  pluginCount: number;
  languageCount: number;
  notificationPermission: string;
  notificationQuery: string;
  webglVendor: string | null;
  webglRenderer: string | null;
};

export type Finding = {
  key: string;
  detail: string;
  severity: "high" | "low";
};

/** The list a fingerprint earns. Pure, so the report can be tested without a browser. */
export function fingerprintIssues(fp: Fingerprint): Finding[] {
  const found: Finding[] = [];
  if (fp.webdriver) found.push({ key: "webdriver", detail: "navigator.webdriver says the window is driven by a tool", severity: "high" });
  if (/HeadlessChrome/i.test(fp.userAgent)) found.push({ key: "userAgent", detail: "the user agent says HeadlessChrome", severity: "high" });
  if (!fp.chromeObject) found.push({ key: "chrome", detail: "window.chrome is missing", severity: "high" });
  if (fp.pluginCount === 0) found.push({ key: "plugins", detail: "navigator.plugins is empty", severity: "low" });
  if (fp.languageCount === 0) found.push({ key: "languages", detail: "navigator.languages is empty", severity: "low" });
  // A person's Chrome answers "prompt" here even when the site has never asked. An automated
  // window answers "denied" before the page had a chance to ask.
  if (fp.notificationPermission === "denied" && fp.notificationQuery === "denied") {
    found.push({ key: "notifications", detail: "notifications read as denied before the page asked", severity: "low" });
  }
  return found;
}

/** Reads the fingerprint from a page the tool already has open. */
export async function readFingerprint(page: Page): Promise<Fingerprint> {
  return page.call<Fingerprint>(`async function () {
    let answer = "unknown";
    try {
      const p = await navigator.permissions.query({ name: "notifications" });
      answer = p && p.state ? p.state : "unknown";
    } catch (e) {}
    let vendor = null;
    let renderer = null;
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
    } catch (e) {}
    return {
      webdriver: navigator.webdriver === true,
      userAgent: String(navigator.userAgent || ""),
      chromeObject: !!window.chrome,
      pluginCount: navigator.plugins ? navigator.plugins.length : 0,
      languageCount: navigator.languages ? navigator.languages.length : 0,
      notificationPermission: typeof Notification === "undefined" ? "none" : Notification.permission,
      notificationQuery: answer,
      webglVendor: vendor,
      webglRenderer: renderer,
    };
  }`);
}

/** The fingerprint and what is wrong with it, for `doctor --protections`. */
export async function probeProtections(page: Page): Promise<{ fingerprint: Fingerprint; findings: Finding[] }> {
  const fingerprint = await readFingerprint(page);
  return { fingerprint, findings: fingerprintIssues(fingerprint) };
}

/** Probes a fresh tab of the runner's own Chrome, which is the window every application is filled in. */
export async function probeRunnerChrome(): Promise<{ fingerprint: Fingerprint; findings: Finding[] }> {
  await ensureBrowser();
  const target = await newTab("about:blank");
  const page = await Page.attach(target);
  try {
    return await probeProtections(page);
  } finally {
    page.close();
    await closeTab(target.id);
  }
}

/** What the doctor prints. Plain words, one line per tell, and a line saying there is nothing to fix. */
export function formatProtections(report: { fingerprint: Fingerprint; findings: Finding[] }): string {
  const fp = report.fingerprint;
  const lines = [`The runner's Chrome reports: webdriver ${fp.webdriver}, window.chrome ${fp.chromeObject ? "present" : "missing"}, ${fp.pluginCount} plugin(s), ${fp.languageCount} language(s), notifications ${fp.notificationQuery}.`];
  if (!report.findings.length) lines.push("No fingerprint tell was found.");
  else for (const f of report.findings) lines.push(`  ${f.severity.toUpperCase()}: ${f.detail}`);
  return lines.join("\n");
}
