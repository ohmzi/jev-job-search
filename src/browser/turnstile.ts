/**
 * The Turnstile widget, and the page Cloudflare puts in front of a form. An explicit widget gets
 * its checkbox pressed once and its response read back. A managed challenge has no checkbox to
 * press: it is given the time it needs to clear by itself, and the person is asked after that.
 * Nothing here forges a token or presses a widget twice.
 */
import { PROTECTIONS } from "../config.js";
import { isManagedCloudflare, clickPoint, humanClick, result, waitForClear, waitForToken, type Adapter, type ChallengeBox, type ProtectionResult } from "./protection.js";

export const turnstile: Adapter = {
  provider: "turnstile",
  async attempt(page, reading, opts): Promise<ProtectionResult> {
    const started = Date.now();
    if (reading.tokens.includes("turnstile")) return result("turnstile", true, started);
    // The Cloudflare interstitial is a page with no checkbox worth pressing: pressing its frame
    // is exactly the bot signal it looks for. It is waited out.
    if (isManagedCloudflare(reading)) {
      const cleared = await waitForClear(page, { ...opts, timeoutMs: Math.min(opts.timeoutMs, PROTECTIONS.passiveWaitMs) });
      return result("turnstile", cleared, started);
    }
    const box = await page.awj<ChallengeBox | null>("challengeBox", "turnstile").catch(() => null);
    if (!box) {
      const cleared = await waitForClear(page, { ...opts, timeoutMs: Math.min(opts.timeoutMs, PROTECTIONS.passiveWaitMs) });
      return result("turnstile", cleared, started);
    }
    await page.bringToFront().catch(() => undefined);
    await humanClick(page, clickPoint(box, PROTECTIONS));
    const how = await waitForToken(page, "turnstile", { ...opts, timeoutMs: Math.min(opts.timeoutMs, PROTECTIONS.tokenWaitMs) });
    return result("turnstile", how === "token", started);
  },
};
