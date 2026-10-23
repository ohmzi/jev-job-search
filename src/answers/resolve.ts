/**
 * What JEV leaves open goes to the writer, which is DeepSeek asked for free text: questions that
 * need writing, fields it was unsure of, and values the page refused. It has no tools, reads the
 * candidate's facts and the open fields, and returns one JSON object. It may also say the job should not be applied to, with a reason.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { DEEPSEEK, PATHS, WRITER } from "../config.js";
import type { QueueEntry } from "../jobs/queue.js";
import type { Profile } from "../profile/schema.js";
import { BANK_DRAFTS, BANK_INTENTS } from "./bank.js";
import { answerContext, jobContext } from "./context.js";
import { fingerprintOf, Resolution, type OpenField } from "./memory.js";

export { Resolution, type OpenField };

const SYSTEM = [
  "You finish job application forms for one candidate. You are given the candidate's facts, the job, what is already filled in, and the fields still open.",
  "Reply with one JSON object and nothing else: {\"verdict\": \"ready\" | \"needs_review\" | \"skip\", \"reason\": string, \"answers\": [{\"selector\": string, \"value\": string, \"reusable\": boolean}], \"note\": {\"what_they_do\": string, \"why_fit\": string}}.",
  "",
  "Truth comes first.",
  "- Use only the candidate's facts, experience, projects, standing answers and the job posting. Never invent a fact, a number, a skill level, a date or a credential.",
  "- Work authorization, citizenship, education and dates are exactly as given. The candidate is authorized only in the countries listed and needs sponsorship elsewhere.",
  "- If a required field cannot be answered truthfully from the facts (a residence the candidate does not have, a self-rating of a skill the facts do not mention, a quiz or take-home, a clearance, a reference's contact details), do not guess: set verdict to \"needs_review\" and say which field in reason.",
  "- needs_review is only for that. When the facts or a standing answer reasonably settle a field, answer it and keep the verdict \"ready\". A person who is not employed has no notice period, so the shortest option is true.",
  "- Never sign for the candidate. A field that asks them to type their name to agree to an NDA or any other contract, and any NDA, is left unanswered and the verdict is \"needs_review\". A checkbox that acknowledges an agreement, a notice or terms follows the standing answers.",
  "- Never choose a date, a time slot or a venue for an interview, an assessment or an event on the candidate's behalf. That field is left unanswered and the verdict is \"needs_review\".",
  "- If the form requires a cover letter or references, set verdict to \"skip\" with the reason.",
  "- Whether to apply is the candidate's decision, already made. A posting that prefers another graduation date, location or visa status is not a reason to stop: answer every question truthfully, follow the standing answers, and note the mismatch in reason while keeping the verdict \"ready\".",
  "",
  "How to answer each kind of field.",
  "- select, radio, combobox with options: value is one option copied exactly. With no options listed for a combobox, value is the text to search for.",
  "- calendar: one date as YYYY-MM-DD, taken from the facts. When the facts give only a month, use its first day.",
  "- checkbox: \"true\" or \"false\". Consent that is needed to submit the application is \"true\". Optional marketing, job alerts, text messages and keeping data for future roles are \"false\".",
  "- text and textarea: write in the candidate's voice, following the voice rules exactly, inside maxLength. Match the length to the question: one line for a one-line box, 60 to 140 words for an open question unless it asks for more or less.",
  "- A checkbox or radio option comes with its question. Decide the whole group together from the question: tick the options that are true for the candidate, and for a yes/no pair tick exactly one.",
  "- A group of checkboxes where none applies: tick \"None of the above\" only if the facts settle every item in the group, otherwise tick \"I prefer not to answer\" when that exists.",
  "- Salary: use the standing wording unless a number is forced, which is needs_review.",
  "- Answer what is asked and no more. Sponsorship, visa status, GPA and anything else that counts against the candidate are stated truthfully wherever a field asks for them, and are not volunteered in free text that did not ask.",
  "- An optional field gets a value whenever the facts give a true one. Leave it out of answers only when nothing true applies to it.",
  "- A field listed with a reason like \"the page did not keep the value\" needs the value in the format the field wants (for a date box, a real date such as 2027-05-03 or 05/03/2027 as the hint or placeholder shows).",
  "",
  "Answer every open field you can, even when the verdict is needs_review, so a person only has to finish what is left.",
  "",
  "Two things that are not part of the form.",
  "- reusable, on each answer: true only when this exact value is the right answer to the same question on any other company's application form. It is false whenever the question or the value names or depends on this company, this role, its team, its product, its office or location, its pay or its dates, and false when you are not sure.",
  "- note is for the candidate's own tracking sheet. what_they_do: one plain sentence on what the company builds, from the posting, or empty if the posting does not say. why_fit: one plain sentence tying a concrete fact about the candidate to this role, written as the candidate's own note: start with the fact, and never write \"the candidate\", \"he\" or \"she\". Under 30 words each, no em dashes, no hype words. Leave note out when no job is given.",
].join("\n");

/** Everything about the candidate that is the same for every job: the voice guide, the facts and the starting drafts. */
export function candidateContext(profile: Profile): Record<string, unknown> {
  const ctx = answerContext(profile, null, "");
  return {
    voice_rules: ctx.voice,
    candidate: {
      ...ctx.candidate,
      email: profile.email,
      phone: `${profile.phone.countryCode} ${profile.phone.national}`,
      education: profile.education,
      address: `${profile.address.city}, ${profile.address.region}, ${profile.address.country}`,
      spokenLanguages: profile.spokenLanguages,
      demographics: profile.demographics,
      preferences: profile.preferences,
      workAuthorization: profile.workAuthorization,
    },
    /** Starting drafts for common questions. Adapt one to the question and the company; text in braces is for you to write. */
    bank: Object.fromEntries(Object.keys(BANK_INTENTS).map((k) => [k, { asks: BANK_INTENTS[k], draft: BANK_DRAFTS[k] }])),
  };
}

/**
 * The system prompt: the rules, then the candidate. It is identical for every job in a run, so the
 * model provider can cache it and each further form pays full price only for its own posting and fields.
 */
export function buildSystem(profile: Profile): string {
  return `${SYSTEM}\n\nThe candidate, the same for every form:\n${JSON.stringify(candidateContext(profile), null, 1)}`;
}

/** Changes whenever anything the writer is told about the candidate changes. Remembered answers are tied to it. */
export const contextFingerprint = (profile: Profile) => fingerprintOf(buildSystem(profile));

/** The part that changes per form: the job, what is already filled, and the open fields. */
export function buildPrompt(entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): string {
  return JSON.stringify({ job: jobContext(entry), already_filled: filled, open_fields: open }, null, 1);
}

/** Pulls the JSON object out of the writer's reply, whether or not it wrapped it in a code fence. */
export function parseResolution(text: string): Resolution {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the writer did not return JSON");
  return Resolution.parse(JSON.parse(text.slice(start, end + 1)));
}

const LOG_SYSTEM = [
  "You write two short cells per job for a job-application tracking sheet. You are given several jobs and one candidate.",
  "Reply with one JSON object and nothing else: {\"notes\": [{\"id\": string, \"what_they_do\": string, \"why_fit\": string}]}, one entry per job, with the job's own id.",
  "what_they_do: one plain sentence on what the company builds, from the posting. If the posting says nothing about it, leave it empty.",
  "why_fit: one plain sentence tying a concrete fact about the candidate to this role, written as the candidate's own note: start with the fact, and never write \"the candidate\", \"he\" or \"she\".",
  "Use only the postings and the candidate's facts. No em dashes, no hype words, under 30 words each.",
].join("\n");

const LogNotes = z.object({ notes: z.array(z.object({ id: z.string(), what_they_do: z.string().default(""), why_fit: z.string().default("") })).default([]) });
export type LogNote = { whatTheyDo: string; whyFit: string };

/**
 * The sheet's "What They Do" and "Why You're a Fit" cells for jobs that were just applied to,
 * all in one writer call: one call for ten jobs costs a fraction of ten calls.
 * Returns nothing for a job the writer skipped, and an empty map if it fails: the log must not block on it.
 */
export async function logNotes(profile: Profile, entries: QueueEntry[]): Promise<Map<string, LogNote>> {
  const out = new Map<string, LogNote>();
  if (!entries.length) return out;
  try {
    const jobs = entries.map((e) => ({ id: e.job.id, company: e.job.company, title: e.job.title, posting: (e.job.description ?? "").slice(0, WRITER.maxNoteChars) }));
    const text = await runWriter(JSON.stringify({ candidate: { summary: profile.summary, facts: profile.facts }, jobs }, null, 1), LOG_SYSTEM, { purpose: "log", jobId: `batch of ${entries.length}` });
    const parsed = LogNotes.parse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    for (const n of parsed.notes) out.set(n.id, { whatTheyDo: n.what_they_do, whyFit: n.why_fit });
  } catch {
    /* the notes are a convenience */
  }
  return out;
}

export type WriterCall = { at: string; purpose: "resolve" | "log" | "tailor"; jobId: string; model: string; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; costUsd: number; ms: number };

/** What the writer has used in this process. costUsd is what the calls cost at DeepSeek's list prices. */
export const writerUsage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

type WriterMeta = { purpose: WriterCall["purpose"]; jobId: string };
type Usage = { prompt_tokens?: number | undefined; completion_tokens?: number | undefined; prompt_cache_hit_tokens?: number | undefined; prompt_cache_miss_tokens?: number | undefined };

/** What one DeepSeek call cost, from its token counts and the list prices in DEEPSEEK. */
export function writerCostUsd(u: Usage): number {
  const input = u.prompt_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? Math.max(0, input - cached);
  return (miss * DEEPSEEK.pricePerMillionInputUsd + cached * DEEPSEEK.pricePerMillionCachedInputUsd + (u.completion_tokens ?? 0) * DEEPSEEK.pricePerMillionOutputUsd) / 1_000_000;
}

function recordWriterCall(u: Usage, meta: WriterMeta, ms: number): void {
  const input = u.prompt_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? 0;
  const call: WriterCall = {
    at: new Date().toISOString(),
    ...meta,
    model: WRITER.model,
    inputTokens: u.prompt_cache_miss_tokens ?? Math.max(0, input - cached),
    cacheWriteTokens: 0,
    cacheReadTokens: cached,
    outputTokens: u.completion_tokens ?? 0,
    costUsd: writerCostUsd(u),
    ms,
  };
  writerUsage.calls += 1;
  writerUsage.inputTokens += input;
  writerUsage.outputTokens += call.outputTokens;
  writerUsage.costUsd += call.costUsd;
  if (process.env.NODE_ENV === "test") return; // a test's fake call is not spend
  try {
    mkdirSync(PATHS.runs, { recursive: true });
    appendFileSync(PATHS.writerUsage, JSON.stringify(call) + "\n");
  } catch {
    /* usage logging is best effort */
  }
}

/**
 * The first call of a process stores the system prompt in DeepSeek's prefix cache. Calls that start
 * while it is still running would each pay full price for it, so they wait for it and then read it.
 */
let warming: Promise<unknown> | null = null;
export async function runWriter(prompt: string, system: string, meta: WriterMeta): Promise<string> {
  if (meta.purpose !== "resolve") return callWriter(prompt, system, meta);
  if (warming) {
    await warming;
    return callWriter(prompt, system, meta);
  }
  const first = callWriter(prompt, system, meta);
  warming = first.catch(() => undefined);
  return first;
}

const WriterReply = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }), finish_reason: z.string().nullish() })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_cache_hit_tokens: z.number().optional(),
      prompt_cache_miss_tokens: z.number().optional(),
    })
    .optional(),
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One free-text call to DeepSeek. The system prompt comes first and is identical for every form, so
 * the provider's prefix cache serves it from the second call on. The reply is a JSON object, which
 * is what every prompt the writer is given asks for. A 429, a 5xx and a dropped connection are
 * retried with a growing pause; any other refusal is final. The key is never part of an error.
 */
async function callWriter(prompt: string, system: string, meta: WriterMeta): Promise<string> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key.");
  let last: Error | undefined;
  for (let attempt = 0; attempt <= WRITER.maxRetries; attempt++) {
    if (attempt > 0) await pause(WRITER.retryBaseMs * 2 ** (attempt - 1));
    const started = Date.now();
    try {
      const res = await fetch(DEEPSEEK.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: WRITER.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
          max_tokens: WRITER.maxOutputTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(WRITER.timeoutMs),
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        last = new Error(`DeepSeek answered ${res.status} for the writer`);
        continue;
      }
      if (!res.ok) {
        let message = "";
        try {
          message = String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "");
        } catch {
          /* the body was not JSON */
        }
        throw new Error(`DeepSeek answered ${res.status}${message ? `: ${message.slice(0, 200)}` : ""}`);
      }
      const reply = WriterReply.parse(JSON.parse(text));
      const first = reply.choices[0];
      const content = first?.message.content ?? "";
      recordWriterCall(reply.usage ?? {}, meta, Date.now() - started);
      if (!content.trim()) {
        last = new Error(`DeepSeek returned an empty reply for the writer${first?.finish_reason ? ` (${first.finish_reason})` : ""}`);
        continue;
      }
      return content;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== "TimeoutError" && name !== "AbortError" && name !== "TypeError") throw err;
      last = new Error(`the writer ${name === "TypeError" ? "could not reach DeepSeek" : `did not answer in ${WRITER.timeoutMs / 1000}s`}`);
    }
  }
  throw last ?? new Error("the writer failed");
}

/** One plain writer call with a system prompt, for checks. Recorded like any other call. */
export const askWriter = (prompt: string, system: string): Promise<string> => callWriter(prompt, system, { purpose: "log", jobId: "doctor" });

export async function resolveOpenFields(profile: Profile, entry: QueueEntry | null, filled: { label: string; value: string }[], open: OpenField[]): Promise<Resolution> {
  if (!open.length) return { verdict: "ready", reason: "", answers: [] };
  const res = parseResolution(await runWriter(buildPrompt(entry, filled, open), buildSystem(profile), { purpose: "resolve", jobId: entry?.job.id ?? "" }));
  const known = new Set(open.map((f) => f.selector));
  return { ...res, answers: res.answers.filter((a) => known.has(a.selector)) };
}
