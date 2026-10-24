/**
 * The cookie banner an employer's page puts in front of its form. The tool picks the choice
 * that allows the least, never "accept all", and only when the banner is actually in the way.
 * OneTrust words it "Only Necessary Cookies", which is the one this list was missing.
 */
import { BROWSER } from "../config.js";
import { sleep, type Page } from "./cdp.js";

export const DECLINE_COOKIES = /^\s*(necessary only|only necessary|only necessary cookies|necessary cookies only|use necessary cookies only|reject all|reject|decline|decline all|refuse|deny)\s*$/i;

/** Clicks the banner's least-permissive choice. False when no such button is on the page. */
export async function dismissConsent(page: Page): Promise<boolean> {
  const hit = await page.awj<{ ok: boolean; x: number; y: number }>("clickByText", DECLINE_COOKIES.source).catch(() => null);
  if (!hit?.ok) return false;
  await page.click(hit.x, hit.y);
  // The banner animates out; the page under it is read after it has gone.
  await sleep(BROWSER.pollMs * 3);
  return true;
}
