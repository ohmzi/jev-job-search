/**
 * What a bot check is, what the tool may try on its own, and the shared pieces every provider
 * adapter uses. The tool clicks a provider's own checkbox once and reads the response back.
 * It never solves a picture grid, a puzzle, or a slider, and it never retries a wall that
 * refused it: what it cannot do with certainty goes to the person.
 */
import { PROTECTIONS } from "../config.js";
import { captchaState } from "./captcha.js";
import { sleep, type Page } from "./cdp.js";

export type ProtectionProvider = "turnstile" | "recaptcha" | "datadome" | "akamai" | "none";

/** One reading of a page: the widgets on it, the responses already filled, its words, and the cookies it carries. */
export type ProtectionReading = {
  descriptors: string[];
  tokens: string[];
  text: string;
  url: string;
  cookies: string[];
};

export type ProtectionSignal = {
  provider: ProtectionProvider;
  blocking: boolean;
  reason: string;
};

/** What an adapter did. `needsHuman` means the person has to take it from here. */
export type ProtectionResult = {
  passed: boolean;
  waitedMs: number;
  needsHuman: boolean;
  provider: ProtectionProvider;
};

/** Where the click goes, in page coordinates. */
export type ChallengeBox = { x: number; y: number; width: number; height: number; kind: "iframe" | "widget" };

export type AdapterOptions = { timeoutMs: number; pollMs?: number };

export type Adapter = {
  provider: ProtectionProvider;
  attempt(page: Page, reading: ProtectionReading, opts: AdapterOptions): Promise<ProtectionResult>;
};

export const result = (provider: ProtectionProvider, passed: boolean, started: number): ProtectionResult => ({
  passed,
  waitedMs: Date.now() - started,
  needsHuman: !passed,
  provider,
});

const sig = (provider: ProtectionProvider, reason: string): ProtectionSignal => ({ provider, blocking: true, reason });
const none = (): ProtectionSignal => ({ provider: "none", blocking: false, reason: "" });

/**
 * Reads the page and returns what, if anything, is standing between the tool and its form.
 * Pure, so the judgement can be tested without a browser. A widget that already carries its
 * vendor's response is solved, whatever frame is still drawn around it.
 */
export function protectionSignal(r: ProtectionReading): ProtectionSignal {
  const shown = (provider: string) => r.descriptors.some((d) => d.includes(`:${provider}:`) && !/:invisible|:badge/.test(d));
  const answered = (provider: string) => r.tokens.includes(provider);
  const words = r.text;

  if (shown("turnstile")) return answered("turnstile") ? none() : sig("turnstile", "a Turnstile widget is on the page");
  if (shown("recaptcha")) return answered("recaptcha") ? none() : sig("recaptcha", "a reCAPTCHA checkbox is on the page");

  const dataDomeCookie = r.cookies.some((c) => /^(datadome|_dd_s|_ddv|_ddgs)$/i.test(c));
  if (/captcha-delivery|datadome/i.test(`${r.url} ${words}`) || (dataDomeCookie && /denied|blocked|captcha|verify/i.test(words))) {
    return sig("datadome", "DataDome is asking for a check");
  }

  const akamaiCookie = r.cookies.some((c) => /^(_abck|bm_sz|ak_bmsc|bm_sv)$/i.test(c));
  if (akamaiCookie && /access denied|reference #|verify you are human|please verify|blocked/i.test(words)) {
    return sig("akamai", "Akamai refused the page");
  }
  if (/just a moment|checking your browser|verify you are human|attention required|enable javascript and cookies/i.test(words)) {
    return sig("turnstile", "Cloudflare is checking the browser");
  }
  if (/access to this page has been denied/i.test(words)) return sig("akamai", "the page says access was denied");
  return none();
}

/** Where the pointer presses: the checkbox for a vendor frame, the middle for a widget drawn in the page. */
export function clickPoint(box: ChallengeBox, shape: { checkboxOffsetX: number; checkboxOffsetY: number }): { x: number; y: number } {
  if (box.kind === "widget") return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return { x: box.x + shape.checkboxOffsetX, y: box.y + box.height * shape.checkboxOffsetY };
}

/** The shape of a pointer walk. Kept separate from the tunables so a caller can pose one exactly. */
export type PointerShape = { steps: number; jitterPx: number; stepMs: number };

const POINTER: PointerShape = { steps: PROTECTIONS.mouseSteps, jitterPx: PROTECTIONS.mouseJitterPx, stepMs: PROTECTIONS.mouseStepMs };

/**
 * Moves the pointer to a control the way a hand would, in several small steps, then presses it
 * once. The last move carries no jitter, so the press lands on the control and nowhere else.
 */
export async function humanClick(page: Page, at: { x: number; y: number }, shape: PointerShape = POINTER): Promise<void> {
  const steps = Math.max(1, shape.steps);
  const from = { x: Math.max(0, at.x - 140), y: Math.max(0, at.y + 50) };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const last = i === steps;
    const jitter = last ? 0 : shape.jitterPx;
    const x = Math.round(from.x + (at.x - from.x) * t + (Math.random() * 2 - 1) * jitter);
    const y = Math.round(from.y + (at.y - from.y) * t + (Math.random() * 2 - 1) * jitter);
    await page.hover(last ? at.x : x, last ? at.y : y);
    if (shape.stepMs > 0) await sleep(shape.stepMs);
  }
  await page.click(at.x, at.y);
}

/** Reads the page for the adapters. */
export async function readProtection(page: Page): Promise<ProtectionReading> {
  const state = await captchaState(page);
  const url = await page.evaluate<string>("location.href").catch(() => "");
  let cookies: string[] = [];
  try {
    const all = await page.send<{ cookies: { name: string }[] }>("Network.getAllCookies");
    cookies = all.cookies.map((c) => c.name);
  } catch {
    cookies = [];
  }
  return { descriptors: state.descriptors, tokens: state.tokens, text: state.text, url, cookies };
}

/**
 * Waits for a widget to answer after its checkbox was clicked. "token" is the response the
 * provider itself filled. "gone" means the widget left without one, which is not proof of
 * anything and is handed to the person like a timeout.
 */
export async function waitForToken(page: Page, provider: ProtectionProvider, opts: AdapterOptions): Promise<"token" | "gone" | "timeout"> {
  const started = Date.now();
  const pollMs = opts.pollMs ?? PROTECTIONS.pollMs;
  while (Date.now() - started < opts.timeoutMs) {
    await sleep(pollMs);
    const state = await captchaState(page).catch(() => null);
    if (!state) continue;
    if (state.tokens.includes(provider)) return "token";
    if (!state.descriptors.some((d) => d.includes(`:${provider}:`))) return "gone";
  }
  return "timeout";
}

/** Waits out a wall that has no widget to press, watching for it to clear by itself. */
export async function waitForClear(page: Page, opts: AdapterOptions): Promise<boolean> {
  const started = Date.now();
  const pollMs = opts.pollMs ?? PROTECTIONS.pollMs;
  while (Date.now() - started < opts.timeoutMs) {
    await sleep(pollMs);
    const now = await readProtection(page).catch(() => null);
    if (now && !protectionSignal(now).blocking) return true;
  }
  return false;
}

/**
 * The reason a fill or a send stops at a wall, or null when it may go on. A failed attempt
 * that left the wall on the page stops it; a wall that cleared by itself does not.
 */
export function protectionStopReason(tried: ProtectionResult | null, now: ProtectionReading | null): string | null {
  if (!tried || tried.provider === "none" || tried.passed) return null;
  const signal = now ? protectionSignal(now) : null;
  return signal?.blocking ? `robot check in front of the form: ${signal.reason}` : null;
}
