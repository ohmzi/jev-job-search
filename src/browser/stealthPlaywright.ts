/**
 * Playwright's stealth evasions, prepared for the tabs the tool opens. The tool keeps launching
 * its own Chrome: the window is visible, the person can take it over, and it stays open after
 * a command ends. Playwright connects to that browser rather than launching one, because a
 * launched browser is closed when the command exits.
 *
 * CDP init scripts belong to the session that registered them, so they are not registered here.
 * They are collected as source text and handed back with the target; the tool's own Page
 * registers them on the session that stays open for the page's life. An evasion that cannot run
 * on a page is skipped: the tool's own bundle (stealth.ts) still covers the tells that matter.
 */
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createPageShim } from "playwright-extra/dist/puppeteer-compatiblity-shim/index.js";
import type { BrowserContext, Page } from "playwright-core";

type Evasion = { onPageCreated?: (page: unknown) => Promise<void> | void };

export type StealthInit = {
  initScripts: string[];
  /** The Network.setUserAgentOverride parameters the plugin asked for. */
  userAgentOverride?: Record<string, unknown>;
};

/** The Playwright page, except that everything it would set on its own connection is collected. */
function captureShim(page: Page, state: StealthInit): unknown {
  const base = createPageShim(page);
  return new Proxy(base as object, {
    get(target, prop, receiver) {
      if (prop === "evaluateOnNewDocument") {
        return async (fn: (...args: unknown[]) => unknown, arg: unknown) => {
          state.initScripts.push(`(${String(fn)})(${JSON.stringify(arg ?? null)});`);
        };
      }
      // The user-agent evasion writes through the session directly, which would be lost with
      // the connection. Its parameters are kept and replayed on the tool's own session.
      if (prop === "_client") {
        return () => ({
          send: async (method: string, params: Record<string, unknown>) => {
            if (method === "Network.setUserAgentOverride") state.userAgentOverride = params;
            return {};
          },
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Runs every enabled evasion against the page and returns what they asked the page to carry. */
async function collectEvasions(page: Page): Promise<StealthInit> {
  const state: StealthInit = { initScripts: [] };
  const stealth = StealthPlugin();
  const shim = captureShim(page, state);
  for (const name of stealth.enabledEvasions) {
    try {
      const loaded = (await import(`puppeteer-extra-plugin-stealth/evasions/${name}/index.js`)) as { default?: (opts?: unknown) => Evasion } | ((opts?: unknown) => Evasion);
      const make = typeof loaded === "function" ? loaded : loaded.default;
      const plugin = make?.({});
      if (plugin?.onPageCreated) await plugin.onPageCreated(shim);
    } catch (err) {
      // This evasion does not fit this page or this browser. The rest still apply.
      if (process.env.AWJ_TRACE) console.error(`[stealth] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return state;
}

/**
 * Opens a tab in the browser at `endpoint` and returns its CDP target id with what Playwright's
 * stealth asked the page to carry. The browser is never closed here, because the tool does not
 * own it and the window has to stay open after the command ends.
 */
export async function openStealthTab(endpoint: string, url: string): Promise<{ targetId: string } & StealthInit> {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context: BrowserContext | undefined = browser.contexts()[0];
    if (!context) throw new Error("the runner's Chrome has no window to open a tab in");
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    try {
      await session.send("Page.enable").catch(() => undefined);
      const stealth = await collectEvasions(page);
      if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
      const { targetInfo } = (await session.send("Target.getTargetInfo")) as unknown as { targetInfo: { targetId: string } };
      return { targetId: targetInfo.targetId, ...stealth };
    } finally {
      await session.detach().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}
