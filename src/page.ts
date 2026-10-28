/**
 * The `page` commands: work on the application form the person is looking at,
 * in the tool's own Chrome window, one field at a time.
 *
 * This is the manual half of the tool. `discover` and `apply` find jobs, rate
 * them and fill whole forms on their own; `page` is for a posting the person
 * opened themselves and wants filled while they watch, then sent by hand.
 * The same pieces do the work: dumpFields.js reads the page, fillFields.js
 * writes values with real input events, dropdowns.ts and calendar.ts drive
 * the controls that need more than one, and every value is read back from the
 * page before it is reported as filled.
 *
 * Nothing here clicks Submit. A page command never sends an application.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { closeTab, ensureBrowser, listTargets, newTab, Page, type Target } from "./browser/cdp.js";
import { dump, goto, install, settle, shownValues } from "./browser/session.js";
import { applyFills, clearBox, uploadFile } from "./browser/fill.js";
import { readDropdownOptions } from "./browser/dropdowns.js";
import type { Fill } from "./browser/report.js";
import type { FieldsDump } from "./forms/fields.js";
import { loadProfile } from "./profile/schema.js";
import { boardFromReferrer, boardProfile, detectBoard, rememberBoard, rememberedBoard } from "./boards.js";

export type TabInfo = { id: string; title: string; url: string; visible: boolean; controls: number; board: string };

/** Which tab to work on: named by id, found by its address, or (neither) the one on screen. */
export type Where = { tab?: string | undefined; url?: string | undefined };

/** Every open tab, and whether it is the one on screen. */
export async function tabs(): Promise<TabInfo[]> {
  await ensureBrowser();
  const targets = (await listTargets()) ?? [];
  const out: TabInfo[] = [];
  for (const t of targets) {
    let visible = false;
    let controls = 0;
    let board = "";
    const page = await Page.attach(t).catch(() => null);
    if (page) {
      try {
        visible = (await page.evaluate<string>("document.visibilityState")) === "visible";
        controls = await page.evaluate<number>("document.querySelectorAll('input, select, textarea').length").catch(() => 0);
        const from = boardFromReferrer(await page.evaluate<string>("document.referrer").catch(() => ""));
        if (from) {
          board = from.title;
          rememberBoard(t.id, from.key);
        }
      } catch {
        // A chrome:// page, or one still loading: listed, not driven.
      }
      page.close();
    }
    out.push({ id: t.id, title: t.title, url: t.url, visible, controls, board });
  }
  return out;
}

/**
 * The tab to work on: the one the person named, the one whose address holds
 * `urlPart`, or the one on screen. A visible tab with controls wins over a
 * visible tab with none (the dashboard next to a form).
 */
export async function pickTab(opts: Where = {}): Promise<Page> {
  await ensureBrowser();
  const targets = (await listTargets()) ?? [];
  if (!targets.length) throw new Error("No tabs are open in the tool's Chrome. Run `node bin/jev.js page open <url>` first.");
  let chosen: Target | undefined;
  if (opts.tab) {
    chosen = targets.find((t) => t.id === opts.tab || t.id.startsWith(opts.tab as string));
    if (!chosen) throw new Error(`No tab with id ${opts.tab}. Run \`node bin/jev.js page tabs\`.`);
  } else if (opts.url) {
    chosen = targets.find((t) => t.url.includes(opts.url as string));
    if (!chosen) throw new Error(`No tab whose address holds "${opts.url}". Run \`node bin/jev.js page tabs\`.`);
  } else {
    const seen: { t: Target; visible: boolean; controls: number }[] = [];
    for (const t of targets) {
      const page = await Page.attach(t).catch(() => null);
      if (!page) continue;
      const visible = await page.evaluate<string>("document.visibilityState").then((s) => s === "visible").catch(() => false);
      const controls = await page.evaluate<number>("document.querySelectorAll('input, select, textarea').length").catch(() => 0);
      page.close();
      seen.push({ t, visible, controls });
    }
    // A visible tab with a form on it wins over the blank or the dashboard beside it.
    const withForm = seen.filter((s) => s.visible && s.controls >= 3);
    chosen = (withForm[withForm.length - 1] ?? seen.find((s) => s.visible) ?? seen[seen.length - 1])?.t;
    if (!chosen) throw new Error("No tab in the tool's Chrome can be driven. Open the job in it first.");
  }
  const page = await Page.attach(chosen);
  await install(page);
  return page;
}

export type DumpOptions = Where & { options?: boolean; text?: number };

/**
 * Read the tab: every control, its label, its current value and the options a
 * native list already knows. With `options`, every custom dropdown is opened
 * and its list read too, which is what a choice field needs.
 */
export async function readPage(o: DumpOptions = {}): Promise<FieldsDump & { bodyText?: string; board?: string }> {
  const page = await pickTab(o);
  try {
    await settle(page);
    await install(page);
    const d = await dump(page);
    const board = boardFromReferrer(await page.evaluate<string>("document.referrer").catch(() => ""));
    if (board) rememberBoard(page.targetId, board.key);
    if (o.options) {
      await readDropdownOptions(page, d.fields);
      await settle(page);
    }
    const out: FieldsDump & { bodyText?: string; board?: string } = d;
    if (board) out.board = board.title;
    if (o.text) {
      const limit = Math.max(500, Math.min(60_000, o.text));
      const text = await page
        .evaluate<string>(`(() => {
        const main = document.querySelector('main, [role=main], form') || document.body;
        return (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${limit});
      })()`)
        .catch(() => "");
      out.bodyText = text;
    }
    return out;
  } finally {
    page.close();
  }
}

/**
 * A fill writes into a page that has a Submit button on it. An Enter that lands on the form, or a
 * widget that presses one itself, would send the application: these two put a stop to that for the
 * length of a fill, and take the stop off before the person is given the page back.
 */
const SUBMIT_GUARD = `(() => {
  if (window.__jevPageGuard) return true;
  window.__jevPageGuard = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  document.addEventListener("submit", window.__jevPageGuard, true);
  return true;
})()`;

const DROP_SUBMIT_GUARD = `(() => {
  if (!window.__jevPageGuard) return true;
  document.removeEventListener("submit", window.__jevPageGuard, true);
  delete window.__jevPageGuard;
  return true;
})()`;

const FillRequest = z.object({
  tab: z.string().optional(),
  url: z.string().optional(),
  /** The board this job is from, when it cannot be read from the tab: android-nj, android-tx, fullstack-nj, fullstack-tx. */
  board: z.string().optional(),
  /**
   * Send the board's resume to the form's resume box. On by default: a form that asks for a resume
   * gets the one the board it came from sends. False leaves the file box to the person.
   */
  resume: z.boolean().default(true),
  fills: z
    .array(
      z.object({
        selector: z.string(),
        kind: z.string(),
        value: z.string(),
        alternates: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  uploads: z.array(z.object({ selector: z.string(), path: z.string() })).default([]),
  /** Selectors to empty first (a box holding a draft the person did not want). */
  clear: z.array(z.string()).default([]),
});
export type FillRequest = z.infer<typeof FillRequest>;

export type FillOutcome = {
  /** The board the job is from, and why that is what it is. */
  board: { key: string; title: string } | null;
  /** The city and state the answers came from: the board's own, or the profile's when no board is known. */
  locatedIn: string;
  boardCandidates: string[];
  boardWhy: string;
  /** The file sent to the resume box, when one was. */
  resume: { path: string; filename: string } | null;
  /** Where the page was before the first value was written. */
  startUrl: string;
  url: string;
  title: string;
  filled: { label: string; selector: string; kind: string; value: string; shown: string }[];
  failed: { label: string; selector: string; why: string }[];
  uploaded: { selector: string; path: string; ok: boolean; why?: string }[];
  /** Required controls the page still shows empty: what a person has to answer. */
  stillEmpty: { label: string; selector: string; kind: string; options: string[] }[];
  /** What the page already held that this run did not write. */
  untouched: { label: string; kind: string; value: string }[];
};

/**
 * Write the values decided for this page, read every one back, and say what
 * the page still asks for. The values themselves are never invented here: the
 * caller (the person, or the writer reading the profile) passes them in.
 */
export async function fillPage(req: FillRequest): Promise<FillOutcome> {
  const plan = FillRequest.parse(req);
  const profile = loadProfile();
  const page = await pickTab(plan);
  try {
    await settle(page);
    await install(page);
    const before = await dump(page);
    const startUrl = before.url;
    const referrer = await page.evaluate<string>("document.referrer").catch(() => "");
    const detected = await detectBoard({
      named: plan.board,
      referrer,
      remembered: rememberedBoard(page.targetId)?.key,
      url: startUrl,
      fallback: profile.resume.path,
    });
    if (detected.board) rememberBoard(page.targetId, detected.board.key);
    const active = detected.board ? boardProfile(detected.board.key, profile) : profile;
    const uploads = [...plan.uploads];
    let autoResume: { selector: string; path: string } | null = null;
    if (plan.resume) {
      const resumeBox = before.fields.find((f) => f.kind === "file" && /resume|\bcv\b|curriculum/i.test(f.label) && !uploads.some((u) => u.selector === f.selector));
      if (resumeBox) {
        autoResume = { selector: resumeBox.selector, path: detected.resume };
        uploads.push(autoResume);
      }
    }
    await page.bringToFront().catch(() => undefined);
    await page.evaluate<boolean>(SUBMIT_GUARD).catch(() => false);
    for (const selector of plan.clear) await clearBox(page, selector).catch(() => false);
    const fills: Fill[] = plan.fills.map((f) => ({ selector: f.selector, kind: f.kind, value: f.value, alternates: f.alternates }));
    const failures = await applyFills(page, fills, active);
    const uploaded: FillOutcome["uploaded"] = [];
    for (const u of uploads) {
      const why = await uploadFile(page, u.selector, u.path).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      uploaded.push({ selector: u.selector, path: u.path, ok: !why, ...(why ? { why } : {}) });
    }
    await settle(page);
    const after = await dump(page);
    // Read every value back the way the page draws it: a picker shows its pick beside a search box that stays empty.
    const shownList = await shownValues(page, after.fields.map((f) => f.selector)).catch(() => [] as string[]);
    const shownBy = new Map(after.fields.map((f, i): [string, string] => [f.selector, (shownList[i] ?? "").trim()]));
    const bySelector = new Map(after.fields.map((f): [string, typeof f] => [f.selector, f]));
    const out: FillOutcome = {
      board: detected.board ? { key: detected.board.key, title: detected.board.title } : null,
      locatedIn: `${active.address.city}, ${active.address.regionCode}`,
      boardCandidates: detected.candidates.map((b) => b.title),
      boardWhy: detected.why,
      resume: autoResume ? { path: autoResume.path, filename: autoResume.path.split("/").pop() ?? "" } : null,
      startUrl,
      url: after.url,
      title: after.title,
      filled: [],
      failed: [],
      uploaded,
      stillEmpty: [],
      untouched: [],
    };
    for (const f of plan.fills) {
      const field = bySelector.get(f.selector);
      const why = failures.find((x) => x.selector === f.selector);
      const shown = shownBy.get(f.selector) ?? "";
      const label = field?.label || f.selector;
      if (why || !shown) out.failed.push({ label, selector: f.selector, why: why?.why ?? "the page shows it empty after the write" });
      else out.filled.push({ label, selector: f.selector, kind: f.kind, value: f.value, shown });
    }
    const uploadedOk = (selector: string) => uploaded.some((u) => u.selector === selector && u.ok);
    const requested = new Set([...plan.fills.map((f) => f.selector), ...uploads.map((u) => u.selector)]);
    for (const f of after.fields) {
      const shown = shownBy.get(f.selector) ?? "";
      if (f.kind === "file") {
        if (f.required && !uploadedOk(f.selector) && !requested.has(f.selector)) {
          out.stillEmpty.push({ label: f.label, selector: f.selector, kind: f.kind, options: [] });
        }
        continue;
      }
      if (!shown && f.required) out.stillEmpty.push({ label: f.label, selector: f.selector, kind: f.kind, options: f.options.map((o) => o.label) });
      else if (!requested.has(f.selector) && shown) out.untouched.push({ label: f.label, kind: f.kind, value: shown });
    }
    return out;
  } finally {
    await page.evaluate<boolean>(DROP_SUBMIT_GUARD).catch(() => false);
    page.close();
  }
}

/** Press a control by its words: "Next", "Continue", "Apply". Never Submit. */
export async function clickText(text: string, opts: Where & { exact?: boolean } = {}): Promise<{ ok: boolean; where: string; navigated: boolean }> {
  const page = await pickTab(opts);
  try {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = opts.exact === false ? escaped : `^\\s*${escaped}\\s*[»›→>]*\\s*$`;
    const p = await page.awj<{ x: number; y: number; ok: boolean; href?: string }>("clickByText", pattern).catch((): { x: number; y: number; ok: boolean; href?: string } => ({ x: 0, y: 0, ok: false }));
    if (!p.ok) return { ok: false, where: text, navigated: false };
    await page.bringToFront().catch(() => undefined);
    if (p.href) {
      await goto(page, p.href);
      return { ok: true, where: p.href, navigated: true };
    }
    await page.click(p.x, p.y);
    await settle(page);
    await install(page);
    return { ok: true, where: (await dump(page)).url, navigated: true };
  } finally {
    page.close();
  }
}

/** The words a form's own Next control uses, in the order a person would try them. */
const NEXT_WORDS = ["Next", "Continue", "Save and continue", "Save & continue", "Next step", "Proceed"];

/**
 * Move a multi-page form on by its own Next button. A control whose words
 * smell of Submit is refused: this command walks pages, it never sends one.
 */
export async function nextPage(opts: Where = {}): Promise<{ ok: boolean; where: string; fields: number }> {
  const page = await pickTab(opts);
  try {
    for (const word of NEXT_WORDS) {
      const pattern = `^\\s*${word}\\s*[»›→>]*\\s*$`;
      const p = await page.awj<{ x: number; y: number; ok: boolean; href?: string }>("clickByText", pattern).catch((): { x: number; y: number; ok: boolean; href?: string } => ({ x: 0, y: 0, ok: false }));
      if (!p.ok) continue;
      await page.bringToFront().catch(() => undefined);
      if (p.href) await goto(page, p.href);
      else {
        await page.click(p.x, p.y);
        await settle(page);
        await install(page);
      }
      const d = await dump(page);
      return { ok: true, where: d.url, fields: d.fields.length };
    }
    return { ok: false, where: "", fields: 0 };
  } finally {
    page.close();
  }
}

/** Close one tab, named by its id or by part of its address. */
export async function closePage(opts: { tab: string } | { url: string }): Promise<string> {
  await ensureBrowser();
  const targets = (await listTargets()) ?? [];
  const t = "tab" in opts ? targets.find((x) => x.id === opts.tab || x.id.startsWith(opts.tab)) : targets.find((x) => x.url.includes(opts.url));
  if (!t) throw new Error("No tab matches. Run `node bin/jev.js page tabs` to see them.");
  await closeTab(t.id);
  return t.url;
}

/** Which board the tab on screen came from, and the resume that goes with it. */
export async function detectTabBoard(opts: Where & { named?: string } = {}): Promise<Awaited<ReturnType<typeof detectBoard>>> {
  const page = await pickTab(opts);
  try {
    const url = (await page.mainFrame()).url;
    const referrer = await page.evaluate<string>("document.referrer").catch(() => "");
    const detected = await detectBoard({ named: opts.named, referrer, remembered: rememberedBoard(page.targetId)?.key, url, fallback: loadProfile().resume.path });
    if (detected.board) rememberBoard(page.targetId, detected.board.key);
    return detected;
  } finally {
    page.close();
  }
}

/** Open a page in the tool's Chrome and say which tab it is. */
export async function openPage(url: string): Promise<{ id: string; url: string }> {
  await ensureBrowser();
  const t = await newTab(url);
  return { id: t.id, url: t.url };
}

/** Go into an embedded application form (a Greenhouse iframe, a Lever frame) by its address. */
export async function openFrame(opts: Where & { index?: number } = {}): Promise<{ url: string }> {
  const page = await pickTab(opts);
  try {
    const d = await dump(page);
    const frame = d.frames[opts.index ?? 0];
    if (!frame) throw new Error("This page has no embedded form. Nothing to go into.");
    await goto(page, frame);
    return { url: frame };
  } finally {
    page.close();
  }
}

/** Read the plan a fill will write: a JSON file, or standard input. */
export function readPlan(file: string): FillRequest {
  const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  return FillRequest.parse(JSON.parse(raw));
}

/** The tabs, one per line, with the one on screen marked. */
export function formatTabs(list: TabInfo[]): string {
  if (!list.length) return "No tabs are open in the tool's Chrome.";
  return list
    .map((t) => `${t.visible ? "▸" : " "} ${t.id.slice(0, 8)}  ${t.url === "" ? "(blank)" : t.url}\n    ${t.title || "(no title)"}${t.controls ? ` · ${t.controls} controls` : ""}${t.board ? ` · from ${t.board}` : ""}`)
    .join("\n");
}
