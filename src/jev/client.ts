/**
 * HTTP client for DeepSeek's chat-completions API.
 *
 * One call = one state + many typed questions. The questions keep the
 * noul/choice/score shapes the rest of the tool validates; this client turns
 * them into a JSON-mode prompt, validates the reply, retries transient
 * failures, tracks spend, and refuses to exceed a per-run spend cap.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEEPSEEK, PATHS } from "../config.js";
import type { Answer, Question, Questions, State, Usage } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type JevClientOptions = {
  apiKey?: string;
  fetchImpl?: FetchLike;
  endpoint?: string;
  model?: string;
  spendCapUsd?: number;
  /** When set, every call's usage is appended as JSON lines here. */
  usageLog?: string | null;
};

export class JevError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "JevError";
  }
}

type Message = { role: "system" | "user" | "assistant"; content: string };

const SYSTEM = `You answer typed questions about a job posting, a web form, or an inbox. You are a classifier, not an assistant: use only the state given, never invent facts, and answer every question.

Reply with one JSON object and nothing else, in this shape:
{"answers":{"<question id>":<answer>,...}}

Answer shapes:
- noul: {"type":"noul","noul":<probability from 0 to 1 that the answer is true>}
- choice: {"type":"choice","choice":"<one key from criteria>","probabilities":{"<key>":<0 to 1>,...},"confidence":<0 to 1>}
- score: {"type":"score","score":<number from 0 to levels-1, fractional allowed>,"legend":{},"probabilities":{},"confidence":<0 to 1>}

Rules:
- Every key in questions must appear in answers, with the type that question names.
- For choice, the choice must be one of that question's criteria keys.
- confidence is your own certainty. Use a low number when the state does not settle it. Never inflate it.
- Do not add commentary, markdown fences, or keys that were not asked for.`;

const Reply = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_cache_hit_tokens: z.number().optional(),
      prompt_cache_miss_tokens: z.number().optional(),
    })
    .optional(),
});
type ReplyUsage = z.infer<typeof Reply>["usage"];

export class JevClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly spendCapUsd: number;
  private readonly usageLog: string | null;
  readonly usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  constructor(opts: JevClientOptions = {}) {
    const key = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!key) throw new JevError("DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key.");
    this.apiKey = key;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.endpoint = opts.endpoint ?? DEEPSEEK.endpoint;
    this.model = opts.model?.trim() || process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK.model;
    this.spendCapUsd = opts.spendCapUsd ?? DEEPSEEK.runSpendCapUsd;
    this.usageLog = opts.usageLog === undefined ? PATHS.jevUsage : opts.usageLog;
  }

  /** Asks every question against one state. Throws JevError on a non-recoverable failure. */
  async decide(state: State, questions: Questions, label = "decide"): Promise<Record<string, Answer>> {
    if (Object.keys(questions).length === 0) return {};
    if (this.usage.costUsd >= this.spendCapUsd) {
      throw new JevError(`DeepSeek spend cap of $${this.spendCapUsd} reached for this run`);
    }
    const messages: Message[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: `STATE:\n${JSON.stringify(state, null, 2)}\n\nQUESTIONS:\n${JSON.stringify(questions, null, 2)}` },
    ];
    let repaired = false;
    let lastError: JevError | undefined;
    for (let attempt = 0; attempt <= DEEPSEEK.maxRetries; attempt++) {
      if (attempt > 0) await sleep(DEEPSEEK.retryBaseMs * 2 ** (attempt - 1));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEEPSEEK.timeoutMs);
      try {
        const body = JSON.stringify({
          model: this.model,
          messages,
          response_format: { type: "json_object" },
          stream: false,
          ...(this.model.includes("reasoner") ? {} : { temperature: 0 }),
        });
        const res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          lastError = new JevError(`DeepSeek ${res.status} on ${label}`, res.status, redact(text));
          continue;
        }
        if (!res.ok) throw new JevError(`DeepSeek ${res.status} on ${label}: ${redact(text)}`, res.status, redact(text));
        const parsed = Reply.safeParse(JSON.parse(text));
        if (!parsed.success) throw new JevError(`DeepSeek returned an unexpected shape on ${label}: ${parsed.error.message}`);
        this.record(parsed.data.usage, label);
        const first = parsed.data.choices[0];
        if (!first) throw new JevError(`DeepSeek returned no answer on ${label}`);
        const content = first.message.content;
        const { answers, problems } = parseAnswers(content, questions);
        if (problems.length === 0) {
          this.assertAllAnswered(questions, answers, label);
          return answers;
        }
        if (!repaired) {
          repaired = true;
          messages.push({ role: "assistant", content });
          messages.push({
            role: "user",
            content: `Some answers were missing or invalid: ${problems.join("; ")}. Reply again with the complete JSON object, {"answers": {...}}, covering every question with the type it names.`,
          });
          continue;
        }
        throw new JevError(`DeepSeek did not answer ${label} in the required shape: ${problems.join("; ")}`);
      } catch (err) {
        if (err instanceof JevError) {
          if (err.status === undefined || (err.status !== 429 && err.status < 500)) throw err;
          lastError = err;
          continue;
        }
        const name = (err as { name?: string }).name;
        lastError = new JevError(`${name === "AbortError" ? "DeepSeek timeout" : "DeepSeek network error"} on ${label}: ${String(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new JevError(`DeepSeek failed on ${label}`);
  }

  private record(u: ReplyUsage, label: string): void {
    const inputTokens = u?.prompt_tokens ?? 0;
    const outputTokens = u?.completion_tokens ?? 0;
    const cached = u?.prompt_cache_hit_tokens ?? 0;
    const miss = u?.prompt_cache_miss_tokens ?? Math.max(0, inputTokens - cached);
    const costUsd =
      (miss * DEEPSEEK.pricePerMillionInputUsd + cached * DEEPSEEK.pricePerMillionCachedInputUsd + outputTokens * DEEPSEEK.pricePerMillionOutputUsd) / 1_000_000;
    this.usage.calls += 1;
    this.usage.inputTokens += inputTokens;
    this.usage.outputTokens += outputTokens;
    this.usage.costUsd += costUsd;
    if (!this.usageLog) return;
    try {
      mkdirSync(path.dirname(this.usageLog), { recursive: true });
      appendFileSync(this.usageLog, JSON.stringify({ at: new Date().toISOString(), label, model: this.model, inputTokens, outputTokens, costUsd }) + "\n");
    } catch {
      /* usage logging is best effort */
    }
  }

  private assertAllAnswered(questions: Questions, answers: Record<string, Answer>, label: string): void {
    const missing = Object.keys(questions).filter((k) => !(k in answers));
    if (missing.length) throw new JevError(`DeepSeek left questions unanswered on ${label}: ${missing.join(", ")}`);
    for (const [key, q] of Object.entries(questions)) {
      const a = answers[key];
      if (a && a.type !== q.type) throw new JevError(`DeepSeek answered ${key} as ${a.type}, expected ${q.type}`);
    }
  }
}

/** Turns one reply's text into typed answers, or names what was wrong with it. */
export function parseAnswers(content: string, questions: Questions): { answers: Record<string, Answer>; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { answers: {}, problems: ["the reply was not JSON"] };
  }
  const raw = isRecord(parsed) && isRecord(parsed.answers) ? parsed.answers : isRecord(parsed) ? parsed : {};
  const answers: Record<string, Answer> = {};
  const problems: string[] = [];
  for (const [key, q] of Object.entries(questions)) {
    if (!(key in raw)) {
      problems.push(`missing ${key}`);
      continue;
    }
    const got = coerceAnswer(q, raw[key]);
    if (typeof got === "string") problems.push(`${key}: ${got}`);
    else answers[key] = got;
  }
  return { answers, problems };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function normalizedProbs(raw: unknown, keys: string[]): Record<string, number> {
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = clamp01(v);
  }
  return out;
}

function coerceAnswer(q: Question, value: unknown): Answer | string {
  if (q.type === "noul") {
    const n =
      typeof value === "number"
        ? value
        : isRecord(value) && typeof value.noul === "number"
          ? value.noul
          : isRecord(value) && typeof value.probability === "number"
            ? value.probability
            : undefined;
    if (typeof n !== "number" || !Number.isFinite(n)) return "expected a probability for a noul question";
    return { type: "noul", noul: clamp01(n) };
  }
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    if (typeof value === "string") {
      if (!keys.includes(value)) return `the choice must be one of these options: ${keys.join(", ")}`;
      return { type: "choice", choice: value, probabilities: { [value]: 1 }, confidence: 0 };
    }
    if (!isRecord(value)) return "expected an object for a choice question";
    const choice = value.choice;
    if (typeof choice !== "string" || !keys.includes(choice)) return `the choice must be one of these options: ${keys.join(", ")}`;
    const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? clamp01(value.confidence) : 0;
    return { type: "choice", choice, probabilities: normalizedProbs(value.probabilities, keys), confidence };
  }
  const rawScore = typeof value === "number" ? value : isRecord(value) ? value.score : undefined;
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) return "expected a score number for a score question";
  const max = q.criteria.length - 1;
  const legend =
    isRecord(value) && isRecord(value.legend)
      ? Object.fromEntries(Object.entries(value.legend).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  const probabilities = isRecord(value) ? normalizedProbs(value.probabilities, q.criteria.map((_, i) => String(i))) : {};
  const confidence = isRecord(value) && typeof value.confidence === "number" && Number.isFinite(value.confidence) ? clamp01(value.confidence) : 0;
  return { type: "score", score: Math.min(max, Math.max(0, rawScore)), legend, probabilities, confidence };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strips anything that looks like a bearer token from an error body before it is surfaced. */
function redact(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]").slice(0, 500);
}
