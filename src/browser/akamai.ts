/**
 * Akamai. Its sensor is passive and its denial page has nothing to press. A visible Chrome
 * carries a real TLS fingerprint already; the adapter only gives the sensor a moment to finish,
 * then hands over. No cookie is written or edited here.
 */
import { PROTECTIONS } from "../config.js";
import { result, waitForClear, type Adapter, type ProtectionResult } from "./protection.js";

export const akamai: Adapter = {
  provider: "akamai",
  async attempt(page, _reading, opts): Promise<ProtectionResult> {
    const started = Date.now();
    const cleared = await waitForClear(page, { ...opts, timeoutMs: Math.min(opts.timeoutMs, PROTECTIONS.passiveWaitMs) });
    return result("akamai", cleared, started);
  },
};
