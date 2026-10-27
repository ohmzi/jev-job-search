import { describe, expect, it } from "vitest";
import { HOURLY } from "../src/config.js";
import { ProfileSchema } from "../src/profile/schema.js";
import { locationWanted, searchJobspy, type JobspyRunner } from "../src/sources/jobspy.js";

const search = (n: number, over: Record<string, unknown> = {}) => ({
  portal: "wide",
  titleInclude: ["(android|mobile)", "(developer|engineer)"],
  titleExclude: [],
  terms: ["android developer"],
  sites: ["indeed", "linkedin"] as ("indeed" | "linkedin")[],
  countryIndeed: "USA",
  apply: false,
  resultsWanted: 50,
  hoursOld: 6,
  maxQueries: 60,
  gapMs: 0,
  minuteOffset: 0,
  locations: Array.from({ length: n }, (_, i) => ({ query: `State ${i}, USA`, distance: 100, accept: [`,\\s*S${i}\\b`] })),
  excludeRemoteOnly: true,
  excludeCompanies: [],
  ...over,
});

describe("a portal that asks once per state", () => {
  it("makes one call per place when the places fit under the ceiling", async () => {
    const asked: string[] = [];
    const runner: JobspyRunner = (args) => {
      asked.push(args[args.indexOf("--location") + 1] as string);
      return { ok: true, stdout: "[]", error: "" };
    };
    await searchJobspy(search(32) as never, { runner });
    expect(asked).toHaveLength(32);
    expect(new Set(asked).size).toBe(32);
  });

  it("never makes more than the ceiling, whatever the profile says", async () => {
    let calls = 0;
    await searchJobspy(search(55) as never, { runner: () => (calls++, { ok: true, stdout: "[]", error: "" }) });
    expect(calls).toBe(HOURLY.maxQueries);
  });

  it("accepts the profile's new ceiling and still refuses a silly one", () => {
    const base = { portal: "x", titleInclude: ["a"], terms: ["a"], locations: [{ query: "a", accept: ["a"] }] };
    expect(() => ProfileSchema.shape.search.unwrap().parse({ ...base, maxQueries: 40 })).not.toThrow();
    expect(() => ProfileSchema.shape.search.unwrap().parse({ ...base, maxQueries: 61 })).toThrow();
  });
});

describe("telling a state by its abbreviation without catching ordinary words", () => {
  const rule = { locations: [{ query: "Oregon, USA", distance: 100, accept: [",\\s*OR\\b", "Oregon"] }, { query: "Indiana, USA", distance: 100, accept: [",\\s*IN\\b", "Indiana"] }], excludeRemoteOnly: true };
  it("takes a city in the state and leaves a word that happens to match", () => {
    expect(locationWanted(["Portland, OR, USA"], rule as never)).toBe(true);
    expect(locationWanted(["Indianapolis, IN, USA"], rule as never)).toBe(true);
    expect(locationWanted(["Remote or hybrid"], rule as never)).toBe(false);
    expect(locationWanted(["Remote in the United States"], rule as never)).toBe(false);
    expect(locationWanted(["Cleveland, OH, USA"], rule as never)).toBe(false);
  });
});

