import { describe, expect, it } from "vitest";
import { HOURLY, RUN } from "../src/config.js";
import { personPasses, waitAtCaptcha } from "../src/run/pipeline.js";
import { showsValue } from "../src/util/dates.js";
import type { JevClient } from "../src/jev/client.js";

const jev = {} as JevClient;

describe("waiting for a person at a human check", () => {
  it("is two minutes at most, and no wait at a sign-in is longer", () => {
    expect(RUN.humanWaitMs).toBe(120_000);
    expect(RUN.signInWaitMs).toBeLessThanOrEqual(RUN.humanWaitMs);
    expect(HOURLY.signInWaitMs).toBeLessThanOrEqual(RUN.humanWaitMs);
  });
  it("counts the form as sent only when the page became a confirmation", async () => {
    let asked = 0;
    const done = async (_j: JevClient, _id: string, o: { timeoutMs: number }) => {
      asked = o.timeoutMs;
      return "submitted" as const;
    };
    expect(await personPasses(jev, "a", RUN.humanWaitMs, done)).toBe(true);
    expect(asked).toBe(RUN.humanWaitMs);
  });
  it("gives the job up when the time runs out", async () => {
    expect(await personPasses(jev, "a", RUN.humanWaitMs, async () => "gave_up")).toBe(false);
  });
  it("does not watch at all when no wait was asked for (the daily run)", async () => {
    let called = false;
    const watch = async () => {
      called = true;
      return "submitted" as const;
    };
    expect(await personPasses(jev, "a", 0, watch)).toBe(false);
    expect(called).toBe(false);
  });
});

describe("a challenge before Submit", () => {
  const jev = {} as JevClient;
  it("is left for the person at once when no wait was asked for (the daily run)", async () => {
    let told = false;
    const r = await waitAtCaptcha(jev, "a", 0, () => { told = true; }, async () => ({ blocking: true, wait: async () => "cleared" }));
    expect(r).toBe("left");
    expect(told).toBe(true); // the person is told before the wait is skipped
  });
  it("goes on to send when the person clears it", async () => {
    const r = await waitAtCaptcha(jev, "a", RUN.humanWaitMs, () => {}, async () => ({ blocking: true, wait: async () => "cleared" }));
    expect(r).toBe("go");
  });
  it("records the application when the page confirmed by itself", async () => {
    const r = await waitAtCaptcha(jev, "a", RUN.humanWaitMs, () => {}, async () => ({ blocking: true, wait: async () => "submitted" }));
    expect(r).toBe("applied");
  });
  it("goes straight on when the form shows no challenge", async () => {
    let told = false;
    const r = await waitAtCaptcha(jev, "a", RUN.humanWaitMs, () => { told = true; }, async () => ({ blocking: false, wait: async () => "cleared" }));
    expect(r).toBe("go");
    expect(told).toBe(false);
  });
});

describe("a prefilled phone", () => {
  it("is not accepted as the profile's number when the box still shows another one", () => {
    expect(showsValue("5515550100", "(214) 555-0100")).toBe(false);
    expect(showsValue("5515550100", "(551) 555-0100")).toBe(true);
  });
});
