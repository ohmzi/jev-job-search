/**
 * The code a board emails to confirm a person is applying, typed into the box that asked for it.
 *
 * The code never travels as an argument and is never printed or recorded: it is read from standard
 * input, written straight into the page, and read back. The caller decides whether to submit; this
 * file only puts the code where the form asked for it.
 */
import type { Page } from "../browser/cdp.js";
import { applyFills } from "../browser/fill.js";
import { shownValues } from "../browser/session.js";
import type { FieldsDump } from "../forms/fields.js";
import type { Profile } from "../profile/schema.js";

/** The box that takes a mailed code. */
export type CodeTarget = { selector: string; kind: string; label: string };

/** Kinds of control a code can go into. A code is never a choice, a date or a file. */
const TAKES_TEXT = new Set(["text", "tel", "number"]);

/** A box whose own words say it is for a code. */
const SAYS_CODE = /(?:security|verification|verify|confirmation|confirm|one[-\s]?time|\botp\b|access)\s*(?:code|pin)?/i;
/** A box that holds a code, but never the one a board mailed. */
const ANOTHER_CODE = /\b(?:zip|postal|post|promo|coupon|discount|referral|area|country|dial|country calling|phone|extension|employee|job|requisition|reference|tax|naics|sic)\b[^.]{0,12}\bcode\b/i;

const wordsOf = (f: FieldsDump["fields"][number]) => `${f.label} ${f.name} ${f.placeholder} ${f.hint} ${f.autocomplete}`.replace(/\s+/g, " ").trim();

/**
 * The one box on the form that takes a mailed code, or why there is no single such box. Two boxes
 * that both look right are never guessed between.
 */
export function codeTargetIn(d: FieldsDump): CodeTarget | { why: string } {
  const usable = d.fields.filter((f) => TAKES_TEXT.has(f.kind));
  const likely = usable.filter((f) => SAYS_CODE.test(wordsOf(f)) && !ANOTHER_CODE.test(wordsOf(f)));
  const boxes = likely.length ? likely : usable.filter((f) => /\bcode\b/i.test(wordsOf(f)) && !ANOTHER_CODE.test(wordsOf(f)));
  if (boxes.length === 1) {
    const [f] = boxes;
    return f ? { selector: f.selector, kind: f.kind, label: f.label || f.name || "code" } : { why: "the form has no box for a code" };
  }
  if (boxes.length > 1) return { why: `the form has ${boxes.length} boxes that could take a code (${boxes.map((f) => f.label || f.name || f.selector).slice(0, 4).join("; ")}), so none is guessed between` };
  return { why: usable.length ? `no box on the form asks for a code (it has: ${usable.map((f) => f.label || f.name || f.selector).slice(0, 6).join("; ")})` : "the form has no box that takes text" };
}

/**
 * The code as it was given, or why it cannot be one. Nothing about the value is echoed back: a
 * refusal names what is wrong with its shape, never the text.
 */
export function cleanCode(raw: string): { code: string } | { why: string } {
  const line = (raw.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  if (!line) return { why: "no code was read from standard input" };
  if (/\s/.test(line)) return { why: "the code has a space in it, so it was not entered" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(line)) return { why: "what was read does not look like a code (4 to 64 letters, digits, dashes or underscores)" };
  return { code: line };
}

/** Writes the code into the box and reads it back. Null when the page shows it, or why it does not. */
export async function enterCode(page: Page, profile: Profile, target: CodeTarget, code: string): Promise<string | null> {
  const failed = await applyFills(page, [{ selector: target.selector, kind: target.kind, value: code }], profile);
  if (failed.length) return failed[0]?.why ?? "the code could not be written";
  const [shown = ""] = await shownValues(page, [target.selector]);
  // The page may change a code's case as it displays it. Anything else means it did not take it.
  if (shown.trim().toLowerCase() !== code.toLowerCase()) return `the code box does not show the code (it ${shown.trim() ? "shows something else" : "is empty"})`;
  return null;
}
