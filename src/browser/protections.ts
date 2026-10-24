/**
 * The chain a form goes through when a bot check is in front of it: read the page, name the
 * check, give the provider's own adapter one attempt, and hand anything left to the person.
 * The result is the same shape for every provider, so a caller does not care which wall it hit.
 */
import { PROTECTIONS } from "../config.js";
import type { Page } from "./cdp.js";
import { akamai } from "./akamai.js";
import { datadome } from "./datadome.js";
import { recaptcha } from "./recaptcha.js";
import { turnstile } from "./turnstile.js";
import { protectionSignal, readProtection, type Adapter, type ProtectionProvider, type ProtectionReading, type ProtectionResult } from "./protection.js";

const ADAPTERS: Partial<Record<ProtectionProvider, Adapter>> = { turnstile, recaptcha, datadome, akamai };

/**
 * One attempt at whatever is on the page. `reading` is passed in when the caller has just read
 * the page, so the same reading is judged and acted on. A pass means the wall is gone; a
 * `needsHuman` means the person has to finish it.
 */
export async function passProtections(page: Page, opts: { reading?: ProtectionReading; timeoutMs?: number; pollMs?: number } = {}): Promise<ProtectionResult> {
  const started = Date.now();
  const reading = opts.reading ?? (await readProtection(page));
  const signal = protectionSignal(reading);
  if (!signal.blocking) return { passed: true, waitedMs: Date.now() - started, needsHuman: false, provider: "none" };
  const adapter = ADAPTERS[signal.provider];
  if (!adapter) return { passed: false, waitedMs: Date.now() - started, needsHuman: true, provider: signal.provider };
  const timeoutMs = Math.max(0, opts.timeoutMs ?? PROTECTIONS.attemptMs);
  return adapter.attempt(page, reading, { timeoutMs, ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}) });
}

export { challengeBlocking, clickPoint, humanClick, isManagedCloudflare, protectionSignal, protectionStopReason, readProtection } from "./protection.js";
export type { ChallengeBox, ProtectionProvider, ProtectionReading, ProtectionResult, ProtectionSignal } from "./protection.js";
