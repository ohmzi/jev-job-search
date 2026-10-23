import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { STEALTH } from "../src/browser/stealth.js";

/**
 * The stealth bundle runs before any page script, so its only contract is what a page can read
 * back from its own globals. It is evaluated in a vm context with the same shape a browser has.
 */
function runScript(over: Record<string, unknown> = {}) {
  const window: Record<string, unknown> = { cdc_adoQpoasnfa76pfcZLmcfl_Array: true, __playwright: {}, __puppeteer_evaluation_script__: true, ...over };
  const navigator = {
    webdriver: true,
    languages: [] as string[],
    plugins: [] as unknown[],
    mimeTypes: [] as unknown[],
    permissions: {
      query: async (p: { name: string }) => ({ state: p.name === "notifications" ? "denied" : "granted" }),
    },
  };
  const context = vm.createContext({ window, navigator, Notification: { permission: "denied" }, document: {} });
  vm.runInContext(STEALTH, context);
  return { context, window, navigator };
}

describe("the stealth bundle a protected page reads", () => {
  it("does not say the browser is driven by a tool", () => {
    const { navigator } = runScript();
    expect(navigator.webdriver).toBe(false);
  });

  it("shows a browser's own plugin list when the window has none", () => {
    const { navigator } = runScript();
    expect((navigator.plugins as unknown[]).length).toBeGreaterThan(0);
    expect((navigator.mimeTypes as unknown[]).length).toBeGreaterThan(0);
  });

  it("says the page may ask for notifications, not that the answer is already no", async () => {
    const { navigator } = runScript();
    const answer = (await navigator.permissions.query({ name: "notifications" })) as { state: string };
    expect(answer.state).toBe("prompt");
  });

  it("gives the window the object Chrome always has", () => {
    const { window } = runScript();
    expect(window.chrome).toBeTypeOf("object");
    expect((window.chrome as { runtime?: unknown }).runtime).toBeTypeOf("object");
  });

  it("takes the known automation names off the window", () => {
    const { window } = runScript();
    for (const name of ["cdc_adoQpoasnfa76pfcZLmcfl_Array", "__playwright", "__puppeteer_evaluation_script__"]) {
      expect(name in window).toBe(false);
    }
  });

  it("leaves a browser that already looks real alone", () => {
    const { navigator, window } = runScript({ chrome: { runtime: {} } });
    expect(navigator.webdriver).toBe(false);
    expect(window.chrome).toBeTypeOf("object");
  });
});
