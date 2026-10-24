import { describe, expect, it } from "vitest";
import { blockingCaptcha, captchaHandoff, captchaVerdict, type CaptchaCheck } from "../src/browser/captcha.js";

describe("a challenge that stops a form", () => {
  it("is a widget of any provider", () => {
    expect(blockingCaptcha(["iframe:recaptcha:normal"])).toBe(true);
    expect(blockingCaptcha(["iframe:hcaptcha:normal"])).toBe(true);
    expect(blockingCaptcha(["widget:turnstile:unknown"])).toBe(true);
    expect(blockingCaptcha(["iframe:arkose:compact"])).toBe(true);
  });
  it("is not an invisible badge, a score-only widget, or a response field", () => {
    expect(blockingCaptcha(["iframe:recaptcha:invisible"])).toBe(false);
    expect(blockingCaptcha(["widget:turnstile:invisible"])).toBe(false);
    expect(blockingCaptcha(["token:turnstile"])).toBe(false);
    expect(blockingCaptcha(["iframe:recaptcha:badge"])).toBe(false);
    expect(blockingCaptcha([])).toBe(false);
  });
  it("is not a widget the person has already solved", () => {
    // The frame stays on the page after a tick. The response is what says it is done.
    expect(blockingCaptcha(["iframe:recaptcha:normal"], ["recaptcha"])).toBe(false);
    // A response for another vendor does not clear it.
    expect(blockingCaptcha(["iframe:recaptcha:normal"], ["hcaptcha"])).toBe(true);
  });
  it("is any blocking widget among the rest", () => {
    expect(blockingCaptcha(["token:recaptcha", "iframe:recaptcha:invisible", "iframe:hcaptcha:normal"])).toBe(true);
  });
});

describe("what to do when a challenge is on the form", () => {
  it("waits only when the person asked to be waited for", () => {
    expect(captchaHandoff(false, 0)).toBe("none");
    expect(captchaHandoff(false, 120_000)).toBe("none");
    expect(captchaHandoff(true, 0)).toBe("leave");
    expect(captchaHandoff(true, 120_000)).toBe("wait");
  });
});

describe("judging a page while the person works", () => {
  const check = (over: Partial<CaptchaCheck>): CaptchaCheck => ({ blocking: false, submitPresent: true, state: null, elapsedMs: 0, clearForMs: 0, ...over });
  const opts = { timeoutMs: 120_000, settleMs: 1_500 };

  it("counts a confirmation at once", () => {
    expect(captchaVerdict(check({ state: "submitted", blocking: true }), opts)).toBe("submitted");
  });
  it("keeps waiting while the challenge is there", () => {
    expect(captchaVerdict(check({ blocking: true }), opts)).toBe("wait");
    expect(captchaVerdict(check({ blocking: true, elapsedMs: 120_000 }), opts)).toBe("timeout");
  });
  it("never calls it clear while the Submit control is gone", () => {
    expect(captchaVerdict(check({ submitPresent: false }), opts)).toBe("wait");
    expect(captchaVerdict(check({ submitPresent: false, elapsedMs: 120_000 }), opts)).toBe("timeout");
  });
  it("calls it clear only after it has stayed clear", () => {
    expect(captchaVerdict(check({ clearForMs: 0 }), opts)).toBe("wait");
    expect(captchaVerdict(check({ clearForMs: 1_500 }), opts)).toBe("cleared");
  });
});
