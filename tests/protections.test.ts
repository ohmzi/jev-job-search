import { describe, expect, it } from "vitest";
import type { Page } from "../src/browser/cdp.js";
import { clickPoint, humanClick, passProtections, protectionSignal, type ChallengeBox, type ProtectionReading } from "../src/browser/protections.js";
import { recaptcha } from "../src/browser/recaptcha.js";
import { turnstile } from "../src/browser/turnstile.js";

const reading = (over: Partial<ProtectionReading> = {}): ProtectionReading => ({ descriptors: [], tokens: [], text: "", url: "https://jobs.example.com/apply", cookies: [], ...over });

describe("what a form is showing", () => {
  it("is a reCAPTCHA checkbox", () => {
    expect(protectionSignal(reading({ descriptors: ["iframe:recaptcha:normal"] }))).toMatchObject({ provider: "recaptcha", blocking: true });
  });
  it("is not a reCAPTCHA score with no widget, or one already answered", () => {
    expect(protectionSignal(reading({ descriptors: ["iframe:recaptcha:invisible"] })).blocking).toBe(false);
    expect(protectionSignal(reading({ descriptors: ["iframe:recaptcha:badge"] })).blocking).toBe(false);
    expect(protectionSignal(reading({ descriptors: ["iframe:recaptcha:normal"], tokens: ["recaptcha"] })).blocking).toBe(false);
  });
  it("is a Turnstile widget", () => {
    expect(protectionSignal(reading({ descriptors: ["widget:turnstile:unknown"] }))).toMatchObject({ provider: "turnstile", blocking: true });
  });
  it("is the page Cloudflare puts before a form", () => {
    expect(protectionSignal(reading({ text: "Just a moment... Checking your browser before accessing" }))).toMatchObject({ provider: "turnstile", blocking: true });
  });
  it("is DataDome, by its frame, its cookie, or its words", () => {
    expect(protectionSignal(reading({ url: "https://geo.captcha-delivery.com/captcha/" })).provider).toBe("datadome");
    expect(protectionSignal(reading({ cookies: ["datadome"], text: "Access to this page has been denied" })).provider).toBe("datadome");
  });
  it("is Akamai, by its cookie and its denial page", () => {
    expect(protectionSignal(reading({ cookies: ["_abck", "bm_sz"], text: "Access Denied. Reference #18.2f4d" }))).toMatchObject({ provider: "akamai", blocking: true });
  });
  it("is nothing at all on an ordinary form", () => {
    expect(protectionSignal(reading({ text: "Apply for this job" }))).toEqual({ provider: "none", blocking: false, reason: "" });
  });
});

describe("where the click lands", () => {
  const box: ChallengeBox = { x: 100, y: 200, width: 300, height: 74, kind: "iframe" };
  it("is the checkbox in a challenge frame", () => {
    expect(clickPoint(box, { checkboxOffsetX: 28, checkboxOffsetY: 0.5 })).toEqual({ x: 128, y: 237 });
  });
  it("is the middle of a widget drawn in the page", () => {
    expect(clickPoint({ ...box, kind: "widget" }, { checkboxOffsetX: 28, checkboxOffsetY: 0.5 })).toEqual({ x: 250, y: 237 });
  });
});

describe("a click a page sees", () => {
  it("moves to the control before it presses, and presses exactly once on it", async () => {
    const moves: [number, number][] = [];
    let pressed: [number, number] | null = null;
    const page = { hover: async (x: number, y: number) => void moves.push([x, y]), click: async (x: number, y: number) => void (pressed = [x, y]) } as unknown as Page;
    await humanClick(page, { x: 128, y: 237 }, { steps: 4, jitterPx: 0, stepMs: 0 });
    expect(moves.length).toBe(4);
    expect(moves.at(-1)).toEqual([128, 237]);
    expect(pressed).toEqual([128, 237]);
  });
});

describe("a challenge the tool tries before handing it to a person", () => {
  const box: ChallengeBox = { x: 10, y: 20, width: 300, height: 74, kind: "iframe" };

  function fakePage(opts: { box: ChallengeBox | null; token?: string; arrivesAfterClicks?: number }) {
    const seen = { clicks: [] as [number, number][], moves: 0 };
    let clicks = 0;
    const page = {
      hover: async () => void seen.moves++,
      click: async (x: number, y: number) => {
        seen.clicks.push([x, y]);
        clicks++;
      },
      bringToFront: async () => undefined,
      awj: async (method: string) => {
        if (method === "challengeBox") return opts.box;
        if (method === "captchaState") {
          const ready = opts.token && clicks >= (opts.arrivesAfterClicks ?? 1);
          return { descriptors: opts.box ? ["iframe:recaptcha:normal"] : [], tokens: ready ? [opts.token] : [], text: "" };
        }
        return null;
      },
    } as unknown as Page;
    return { page, seen };
  }

  it("passes a reCAPTCHA when the response arrives", async () => {
    const { page, seen } = fakePage({ box, token: "recaptcha" });
    const result = await recaptcha.attempt(page, reading({ descriptors: ["iframe:recaptcha:normal"] }), { timeoutMs: 300, pollMs: 5 });
    expect(result).toMatchObject({ passed: true, needsHuman: false, provider: "recaptcha" });
    expect(seen.clicks).toHaveLength(1);
  });

  it("hands a reCAPTCHA to the person when no response arrives", async () => {
    const { page, seen } = fakePage({ box });
    const result = await recaptcha.attempt(page, reading({ descriptors: ["iframe:recaptcha:normal"] }), { timeoutMs: 60, pollMs: 5 });
    expect(result.passed).toBe(false);
    expect(result.needsHuman).toBe(true);
    expect(seen.clicks).toHaveLength(1);
  });

  it("passes a Turnstile when its token arrives", async () => {
    const { page } = fakePage({ box, token: "turnstile" });
    const result = await turnstile.attempt(page, reading({ descriptors: ["iframe:turnstile:normal"] }), { timeoutMs: 300, pollMs: 5 });
    expect(result).toMatchObject({ passed: true, needsHuman: false, provider: "turnstile" });
  });

  it("goes straight on when there is no challenge", async () => {
    const { page, seen } = fakePage({ box: null });
    const result = await passProtections(page, { reading: reading() });
    expect(result).toMatchObject({ passed: true, needsHuman: false, provider: "none" });
    expect(seen.clicks).toHaveLength(0);
  });

  it("never clicks a DataDome or an Akamai wall", async () => {
    for (const [cookies, text] of [
      [["datadome"], "Access to this page has been denied"],
      [["_abck"], "Access Denied. Reference #18.2f4d"],
    ] as const) {
      const { page, seen } = fakePage({ box: null });
      const result = await passProtections(page, { reading: reading({ cookies: [...cookies], text }), timeoutMs: 0 });
      expect(result.needsHuman).toBe(true);
      expect(seen.moves).toBe(0);
      expect(seen.clicks).toHaveLength(0);
    }
  });
});
