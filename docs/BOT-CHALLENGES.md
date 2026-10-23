# Plan: bot-challenge handling for jev-job-search

Goal: detect and pass through Cloudflare Turnstile, reCAPTCHA v2/v3, DataDome, and Akamai on the protected job-application forms this tool already fills.

## Corrections to the original request

- **This project has no Playwright.** `src/browser/cdp.ts` is a hand-rolled zero-dependency CDP client driving a real visible Chrome (ARCHITECTURE.md explains the tool deliberately needs no Playwright or Puppeteer). "Replace existing Playwright" therefore means either adding a stealth layer on top of the CDP core, or swapping the core.
- **`undetected-chromedriver` is Python/Selenium** and is not compatible with this Node 22 codebase. Its JS analogues are `puppeteer-extra-plugin-stealth` (`puppeteer-core`) or Playwright + `playwright-extra`. The plan below assumes you want working bot-detection handling, with stealth via `puppeteer-core` as the lightest real off-the-shelf option.

The design constraint that stays: a *visible* browser the person can watch, fix, and take over (the existing philosophy in `src/browser/submit.ts`). Every adapter below must degrade to human-in-the-loop, never silent retries against a bot wall.

---

## Phase 0: Detection baseline (read-only)

- Add `src/browser/detect.ts`: probes what a protected page sees from *our* browser: `navigator.webdriver`, UA / UA-CH consistency, plugins, languages, WebGL renderer, `window.chrome`, Permissions API answers.
- Extend `doctor` (`src/doctor.ts`) with a `jev doctor --protections` check that loads local fixture pages (Phase 5) and reports which fingerprints trip Turnstile / reCAPTCHA v3 score / DataDome / Akamai.
- Reuse existing pacing: the stagger/pace utilities behind `tests/stagger.test.ts` and `tests/pace.test.ts` already exist; centralize human-like input cadence there instead of duplicating it in each adapter.

## Phase 1: Stealth core

- `src/browser/stealth.ts`: a script bundle injected via CDP `Page.addScriptToEvaluateOnNewDocument` (one new method call in `cdp.ts`):
  - `navigator.webdriver` → false,
  - `navigator.plugins` / `navigator.languages` consistent with locale,
  - `permissions.query` consistency,
  - `window.chrome` presence,
  - scrub automation artifacts (`cdc_*`, `__playwright*,` etc.).
- Because we already run a **visible** real Chrome (no `--enable-automation`, no headless), most headless tells are gone, and the injected script covers the rest. This is roughly what `puppeteer-extra-plugin-stealth` does, minus the dependency.

**Option B (off-the-shelf library):** add `puppeteer-core` + `@puppeteer-extra/puppeteer-extra-plugin-stealth`, let it replace `cdp.ts`'s low-level page driving while keeping `ensureBrowser()`'s visible-window launch (connect to `127.0.0.1:${BROWSER.port}` via `connectOverCDP`). Trade-off: ~2 new dependencies vs. zero.

Decision gate: if Option A's fingerprint report (Phase 0) is clean, stop at A: fewer moving parts, and the repo's zero-dep policy stays intact.

## Phase 2: Per-protection adapters

New modules in `src/browser/`, each with the same shape, **detect → handle → verify**:

- **`turnstile.ts`**: find the Turnstile iframe (`challenges.cloudflare.com/turnstile/api/v1/...`), detect managed vs. explicit widget, poll for the response token (`cf-chl-widget-response` / callback-fired state). If a managed challenge fails on bot score, escalate to Phase 1 stealth fixes, never brute-force the widget.
- **`recaptcha.ts`**: v2, locate the `google.com/recaptcha/api2/anchor` checkbox iframe, real mouse path via existing CDP input dispatch with jittered movement; verify `g-recaptcha-response`. v3: score-only, no UI, so the adapter's job is behavioral quality (typing cadence, mouse entropy) then polling `grecaptcha.getResponse()`.
- **`datadome.ts`**: detect `_ddgs` / `_ddv` cookies and `geo.captcha-delivery.com` redirects; handle = wait for human clearance or pass-through on a trusted-profile state; verify the cookie flips to a valid token.
- **`akamai.ts`**: the hardest one: `_abck` / `bm_sz` / `ak_bmsc` sensor flow; detect via beacon URLs and 503/denied pages; handle = human-in-the-loop wait then verify `ak_bmsc` presence. Akamai also fingerprints TLS/JA3, and real visible Chrome is already fine there.

All four return the same result shape `submit.ts` expects: `{ passed, waitedMs, needsHuman }`, so CLI behavior stays "person watches and takes over".

## Phase 3: Wiring

- `formRunner.ts`: run the adapter chain after page-state classification; escalate human-wait state into the existing `humanCheck` flow.
- `config.ts`: per-protection config (timeout, retry budget) as new constants, grouped like the existing `BROWSER` block.
- `cli.ts` / `doctor.ts`: expose status: `jev status` shows last challenge outcome per protection.

## Phase 4: Test fixtures (offline, no real Cloudflare/Akamai traffic)

- `tests/fixtures/` static pages that *simulate* each wall: fake Turnstile iframe with a script that flips a token after N human-ish mouse events; fake reCAPTCHA v2 anchor + v3 score object; fake DataDome cookie set/unset logic; fake Akamai denied → granted transition on `_abck` change.
- `tests/protections.test.ts`: for each adapter: detect fires on the fixture, handle succeeds on benign fixture, handle correctly escalates to `needsHuman` on the failing fixture.
- Extend `tests/formRunner.test.ts` so the runner escalates when an adapter reports `needsHuman`.

## Phase 5: Rollout order

1. Phase 0 `detect.ts` + `doctor --protections` (read-only, safe to merge immediately).
2. Phase 1 stealth injection (Option A first; Option B only if the fingerprint report demands it).
3. Adapters one at a time, Turnstile → reCAPTCHA → DataDome → Akamai (rough order of how often they appear on target forms, then verify against real application logs before locking the queue), each with its fixture tests from Phase 4 in the same PR.
4. Phase 3 wiring lands with the first adapter; no CLI surface changes until at least one adapter exists.

## Out of scope (and why)

- No residential proxy rotation, no token-resale services, no solving CAPTCHAs for other users' accounts: this stays a single-user tool driving the person's own applications.
- No headless mode: the visible window is a feature (supervision + takeover), not a limitation to remove.
- No `undetected-chromedriver` / Selenium path: wrong language, and it would duplicate the CDP core.
