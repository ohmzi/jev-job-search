import { describe, expect, it } from "vitest";
import { fingerprintIssues, formatProtections, type Fingerprint } from "../src/browser/detect.js";

const raw = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  webdriver: false,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  chromeObject: true,
  pluginCount: 5,
  languageCount: 2,
  notificationPermission: "denied",
  notificationQuery: "prompt",
  webglVendor: "Google Inc. (Intel)",
  webglRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics)",
  ...over,
});

describe("what a protected page can tell about the window", () => {
  it("finds nothing to fix in a window that reads as a person's", () => {
    expect(fingerprintIssues(raw())).toEqual([]);
  });

  it("names a window that says it is driven by a tool", () => {
    const found = fingerprintIssues(raw({ webdriver: true }));
    expect(found.map((f) => f.key)).toContain("webdriver");
    expect(found.find((f) => f.key === "webdriver")?.severity).toBe("high");
  });

  it("names a headless user agent", () => {
    const found = fingerprintIssues(raw({ userAgent: "Mozilla/5.0 HeadlessChrome/141.0.0.0" }));
    expect(found.find((f) => f.key === "userAgent")?.severity).toBe("high");
  });

  it("names an empty plugin list and an empty language list", () => {
    const keys = fingerprintIssues(raw({ pluginCount: 0, languageCount: 0 })).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["plugins", "languages"]));
  });

  it("names the notifications answer that only an automated window gives", () => {
    const found = fingerprintIssues(raw({ notificationPermission: "denied", notificationQuery: "denied" }));
    expect(found.find((f) => f.key === "notifications")?.severity).toBe("low");
  });

  it("does not mind a person's window that has notifications denied", () => {
    expect(fingerprintIssues(raw({ notificationPermission: "denied", notificationQuery: "prompt" }))).toEqual([]);
  });
});

describe("the doctor's protections page", () => {
  it("says so plainly when there is nothing to fix", () => {
    const text = formatProtections({ fingerprint: raw(), findings: [] });
    expect(text).toContain("No fingerprint tell");
  });

  it("names each tell with its severity", () => {
    const fingerprint = raw({ webdriver: true, pluginCount: 0 });
    const text = formatProtections({ fingerprint, findings: fingerprintIssues(fingerprint) });
    expect(text).toContain("HIGH: navigator.webdriver");
    expect(text).toContain("LOW: navigator.plugins");
  });
});
