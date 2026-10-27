import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outsideStates, statesOf } from "../src/jobs/states.js";
import { ProfileSchema } from "../src/profile/schema.js";

const example = JSON.parse(readFileSync(new URL("../data/profile.example.json", import.meta.url), "utf8"));
const east = ["NJ", "NY", "PA", "CT", "MA", "DC", "VA", "NC", "OH", "IL"];
const west = ["TX", "OK", "LA", "CO", "AZ", "CA", "WA", "GA", "FL", "TN"];

describe("statesOf", () => {
  it.each([
    ["Dallas, TX", ["TX"]],
    ["Jersey City, New Jersey", ["NJ"]],
    ["US-NJ-Princeton", ["NJ"]],
    ["New York, NY, United States", ["NY"]],
    ["Washington, DC", ["DC"]],
    ["Washington D.C.", ["DC"]],
    ["Seattle, Washington", ["WA"]],
    ["Charleston, West Virginia", ["WV"]],
    ["Richmond, Virginia", ["VA"]],
    ["Little Rock, Arkansas", ["AR"]],
    ["Albuquerque, New Mexico", ["NM"]],
    ["New Brunswick, NJ", ["NJ"]],
    ["Delaware, OH", ["OH"]],
    ["Washington, PA", ["PA"]],
    ["Vancouver, WA", ["WA"]],
    ["Remote - TX", ["TX"]],
    ["Remote in USA (FL)", ["FL"]],
    ["Texas (Remote)", ["TX"]],
    ["Hybrid - Plano", ["TX"]],
    ["SF", ["CA"]],
    ["NYC", ["NY"]],
    ["LA", ["CA"]],
    ["Baton Rouge, LA", ["LA"]],
  ])("%s is in %j", (loc, states) => {
    expect(statesOf(loc)).toEqual(states);
  });
  it.each([
    ["Remote"], ["Remote in USA"], ["United States"], ["US Remote"],
    ["Toronto, ON, Canada"], ["Toronto, CA"], ["London, Ontario"], ["Vancouver, BC"], ["Remote - Canada"],
    ["Tel Aviv, IL, Israel"], ["Mexico City, Mexico"], ["Boston Spa, Wetherby, UK"], ["Remote in South Georgia and the South Sandwich Islands"],
    ["Hybrid, in office or at home"], ["Portland"],
  ])("%s is in no state", (loc) => {
    expect(statesOf(loc)).toEqual([]);
  });
});

describe("outsideStates", () => {
  it("keeps every posting when no states are chosen", () => {
    expect(outsideStates(["Dallas, TX"], [])).toBeNull();
  });
  it("keeps a posting in a chosen state and refuses one in another", () => {
    expect(outsideStates(["Newark, NJ"], east)).toBeNull();
    expect(outsideStates(["Newark, NJ"], west)).toBe("outside your states (NJ)");
    expect(outsideStates(["Austin, TX"], west)).toBeNull();
    expect(outsideStates(["Austin, TX"], east)).toMatch(/outside your states \(TX\)/);
  });
  it("keeps a posting when any one of its places is chosen", () => {
    expect(outsideStates(["San Francisco, CA", "New York, NY"], east)).toBeNull();
    expect(outsideStates(["San Francisco, CA", "New York, NY"], west)).toBeNull();
    expect(outsideStates(["Austin or Seattle"], west)).toBeNull();
  });
  it("keeps remote and nationwide postings for every set of states", () => {
    for (const states of [east, west]) {
      expect(outsideStates(["Remote"], states)).toBeNull();
      expect(outsideStates(["Remote - US"], states)).toBeNull();
      expect(outsideStates(["Boise, ID; Remote"], states)).toBeNull();
      expect(outsideStates(["Boise, ID", "United States"], states)).toBeNull();
    }
  });
  it("keeps what it cannot place and what is outside the United States", () => {
    expect(outsideStates(["Toronto, ON"], west)).toBeNull();
    expect(outsideStates(["Boise, ID", "Toronto, ON"], west)).toBeNull();
    expect(outsideStates(["Multiple Locations"], west)).toBeNull();
    expect(outsideStates([], west)).toBeNull();
  });
  it("names at most four states in its reason", () => {
    expect(outsideStates(["Boise, ID", "Omaha, NE", "Fargo, ND", "Helena, MT", "Casper, WY"], east)).toBe("outside your states (ID, NE, ND, MT and 1 more)");
  });
});

describe("profile searchStates", () => {
  it("defaults to every state", () => {
    const { searchStates: _, ...preferences } = example.preferences;
    expect(ProfileSchema.parse({ ...example, preferences }).preferences.searchStates).toEqual([]);
  });
  it("takes codes in any case and refuses what is not a state", () => {
    const parse = (searchStates: string[]) => ProfileSchema.safeParse({ ...example, preferences: { ...example.preferences, searchStates } });
    const ok = parse(["nj", " tx "]);
    expect(ok.success && ok.data.preferences.searchStates).toEqual(["NJ", "TX"]);
    const bad = parse(["NJ", "Texas"]);
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toMatch(/"TEXAS" is not a two-letter US state code/);
  });
});
