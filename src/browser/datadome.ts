/**
 * DataDome. Its slider and its picture are traps for a script, so nothing is pressed. The wall
 * carries a cookie the sensor sets on its own; the adapter gives it a moment to clear and then
 * hands the window to the person.
 */
import { PROTECTIONS } from "../config.js";
import { result, waitForClear, type Adapter, type ProtectionResult } from "./protection.js";

export const datadome: Adapter = {
  provider: "datadome",
  async attempt(page, _reading, opts): Promise<ProtectionResult> {
    const started = Date.now();
    const cleared = await waitForClear(page, { ...opts, timeoutMs: Math.min(opts.timeoutMs, PROTECTIONS.passiveWaitMs) });
    return result("datadome", cleared, started);
  },
};
