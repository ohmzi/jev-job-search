/**
 * Bot checks on a form. The tool never passes one: it finds the widget, tells the
 * person, waits while they do it, and only then lets the submit guard run again.
 * A widget that has given a response counts as solved, because the frame stays on
 * the page after the person ticks it.
 */
import { BROWSER } from "../config.js";
import type { PageState } from "../forms/pageState.js";
import { decidePageState } from "../forms/pageState.js";
import type { JevClient } from "../jev/client.js";
import { sleep, type Page } from "./cdp.js";
import { install } from "./session.js";

const PART = /^(iframe|widget|token):([^:]+)(?::([^:]*))?$/;

/**
 * True when a widget on the page is a challenge the person has to do. An invisible
 * score or a badge is not, and a widget whose vendor has a response is already solved.
 */
export function blockingCaptcha(descriptors: string[], tokens: string[] = []): boolean {
  return descriptors.some((d) => {
    const m = PART.exec(d);
    if (!m) return false;
    const [, kind, vendor = "", size = ""] = m;
    if (kind !== "iframe" && kind !== "widget") return false;
    if (size === "invisible" || size === "badge") return false;
    return !tokens.includes(vendor);
  });
}

/** What to do about a challenge before Submit: nothing, wait for the person, or leave it for them. */
export function captchaHandoff(blocking: boolean, humanWaitMs: number): "none" | "wait" | "leave" {
  if (!blocking) return "none";
  return humanWaitMs > 0 ? "wait" : "leave";
}

export type CaptchaPageState = {
  /** Raw descriptors from pageHelpers.js. */
  descriptors: string[];
  /** Vendors whose response field is filled: "recaptcha", "hcaptcha", "turnstile". Never the response itself. */
  tokens: string[];
  text: string;
};

/** One reading of the page while the person works on it. */
export type CaptchaCheck = {
  /** A challenge is on the page and not yet answered. */
  blocking: boolean;
  submitPresent: boolean;
  state: PageState["state"] | null;
  elapsedMs: number;
  /** How long the widget has been clear with the Submit control present. */
  clearForMs: number;
};

/** What one reading of the page means: send, give up, or look again. Judged without a browser. */
export function captchaVerdict(c: CaptchaCheck, opts: { timeoutMs: number; settleMs: number }): "submitted" | "timeout" | "cleared" | "wait" {
  if (c.state === "submitted") return "submitted";
  if (c.blocking) return c.elapsedMs >= opts.timeoutMs ? "timeout" : "wait";
  // The form's Submit control is what proves the form is still the form. Without it, the page
  // has moved on and only a confirmation judgement can say what happened.
  if (!c.submitPresent) return c.elapsedMs >= opts.timeoutMs ? "timeout" : "wait";
  return c.clearForMs >= opts.settleMs ? "cleared" : "wait";
}

/** Reads the page through the in-page helper. */
export async function captchaState(page: Page): Promise<CaptchaPageState> {
  const raw = await page.awj<{ descriptors: string[]; tokens: string[]; text: string }>("captchaState");
  return { descriptors: raw.descriptors ?? [], tokens: raw.tokens ?? [], text: raw.text ?? "" };
}

/** True when a widget on the page is a challenge the person has to do. An invisible */
export type ChallengeReading = {
  /** A challenge is on the page and not yet answered. */
  blocking: boolean;
  /** The page's words, used to judge a page that moved on. */
  text: string;
};

/**
 * Brings a job's tab to the front and watches it while the person passes a challenge.
 * Nothing is typed or clicked. "cleared" means the Submit control is still there and the
 * challenge has been gone for the settle time. "submitted" means the page confirmed by
 * itself. "timeout" means nothing happened in time. `read` lets a caller judge the wall by
 * more than a widget's frame: a DataDome or Akamai page has words and cookies instead.
 */
export async function waitForCaptcha(jev: JevClient, page: Page, jobId: string, opts: { timeoutMs: number; submitSelector: string; stop?: () => boolean; read?: (page: Page) => Promise<ChallengeReading> }): Promise<"cleared" | "submitted" | "timeout"> {
  if (opts.timeoutMs <= 0) return "timeout";
  const challenge = opts.read ?? (async (p: Page) => {
    const s = await captchaState(p);
    return { blocking: blockingCaptcha(s.descriptors, s.tokens), text: s.text };
  });
  await page.bringToFront().catch(() => undefined);
  const start = Date.now();
  let baseline = "";
  let clearSince: number | null = null;
  while (Date.now() - start < opts.timeoutMs && !opts.stop?.()) {
    await sleep(BROWSER.captchaPollMs);
    let read: ChallengeReading;
    let submitPresent = false;
    try {
      await install(page);
      read = await challenge(page);
      submitPresent = (await page.awj<{ ok: boolean }>("point", opts.submitSelector)).ok;
    } catch {
      continue; // mid-navigation: read again
    }
    let state: PageState["state"] | null = null;
    if (read.text !== baseline) {
      baseline = read.text;
      // A changed page with no challenge on it is worth one judgement; otherwise keep waiting.
      if (!read.blocking && !/verification code was sent|enter the \S+ code|security code/i.test(read.text)) {
        state = (await decidePageState(jev, read.text, await page.evaluate<string>("location.href"), jobId)).state;
      }
    }
    const now = Date.now();
    const clear = !read.blocking && submitPresent;
    if (clear && clearSince === null) clearSince = now;
    if (!clear) clearSince = null;
    const verdict = captchaVerdict({ blocking: read.blocking, submitPresent, state, elapsedMs: now - start, clearForMs: clearSince === null ? 0 : now - clearSince }, { timeoutMs: opts.timeoutMs, settleMs: BROWSER.captchaSettleMs });
    if (verdict !== "wait") return verdict;
  }
  return "timeout";
}
