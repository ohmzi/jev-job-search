/**
 * The reCAPTCHA v2 checkbox. The tool presses the box in the anchor frame once, then reads the
 * response the provider writes back. A picture grid or audio challenge is the person's, and the
 * adapter hands over rather than trying it. A v3 score has no widget to press; it is covered by
 * the fingerprint and the pacing of the fill, and it never blocks a form on its own.
 */
import { PROTECTIONS } from "../config.js";
import { clickPoint, humanClick, result, waitForToken, type Adapter, type ChallengeBox, type ProtectionResult } from "./protection.js";

export const recaptcha: Adapter = {
  provider: "recaptcha",
  async attempt(page, reading, opts): Promise<ProtectionResult> {
    const started = Date.now();
    if (reading.tokens.includes("recaptcha")) return result("recaptcha", true, started);
    const box = await page.awj<ChallengeBox | null>("challengeBox", "recaptcha").catch(() => null);
    if (!box) return result("recaptcha", false, started);
    await page.bringToFront().catch(() => undefined);
    await humanClick(page, clickPoint(box, PROTECTIONS));
    const how = await waitForToken(page, "recaptcha", { ...opts, timeoutMs: Math.min(opts.timeoutMs, PROTECTIONS.tokenWaitMs) });
    return result("recaptcha", how === "token", started);
  },
};
