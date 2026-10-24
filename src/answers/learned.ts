/**
 * Answers the LinkedIn Easy Apply walk filled in without a person. The walk
 * runs after the application has been sent, so these answers cannot ride the
 * needs-review question flow. They wait in data/learned.json until a person
 * confirms them, and only then become standing answers in the profile.
 *
 * One entry is kept per question, whichever job raised it. A confirmed answer
 * is written as {question, answer} only: the options the walk saw belong to
 * that one form and are not a standing answer.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PATHS } from "../config.js";
import { ProfileSchema } from "../profile/schema.js";
import { withStore, writeAtomic } from "../util/store.js";

export type Pending = { id: string; jobId: string; company: string; title: string; question: string; answer: string; options: string[]; at: string };
export type NewPending = Omit<Pending, "id" | "at">;

const PendingSchema = z.object({
  id: z.string().min(1),
  jobId: z.string(),
  company: z.string(),
  title: z.string(),
  question: z.string(),
  answer: z.string(),
  options: z.array(z.string()).default([]),
  at: z.string(),
});

const LearnedFile = z.object({ pending: z.array(PendingSchema).default([]) });

/** The pending answers. A file that cannot be read is an empty one, as with the answer memory. */
export function loadLearned(file = PATHS.learned): { pending: Pending[] } {
  if (!existsSync(file)) return { pending: [] };
  try {
    return LearnedFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { pending: [] };
  }
}

/** Adds the answers the walk gave, skipping any question already waiting. Returns how many were new. */
export function addLearned(rows: NewPending[], file = PATHS.learned): number {
  if (!rows.length) return 0;
  return withStore(() => {
    const { pending } = loadLearned(file);
    const seen = new Set(pending.map((p) => p.question));
    const fresh: Pending[] = [];
    for (const row of rows) {
      if (seen.has(row.question)) continue;
      seen.add(row.question);
      fresh.push({
        id: randomUUID(),
        jobId: row.jobId,
        company: row.company,
        title: row.title,
        question: row.question,
        answer: row.answer,
        options: [...row.options],
        at: new Date().toISOString(),
      });
    }
    if (!fresh.length) return 0;
    writeAtomic(file, JSON.stringify({ pending: [...pending, ...fresh] }, null, 2) + "\n");
    return fresh.length;
  });
}

/**
 * Turns one pending answer into a standing one. The answer given is the person's, which may be
 * the walk's own wording or their edit. An entry with the same question is replaced, never
 * duplicated. A question or answer that is only whitespace is refused, so a blank standing
 * answer can never reach the profile. The profile is parsed whole before either file is written.
 */
export function confirmLearned(id: string, answer: string, files: { pending?: string; profile?: string } = {}): { question: string; answer: string } {
  return withStore(() => {
    const pendingFile = files.pending ?? PATHS.learned;
    const profileFile = files.profile ?? PATHS.profile;
    const { pending } = loadLearned(pendingFile);
    const row = pending.find((p) => p.id === id);
    if (!row) throw new Error(`No learned answer with id ${id}`);
    if (!row.question.trim()) throw new Error("a learned answer needs a question before it can be confirmed");
    const final = { question: row.question, answer: answer.trim() };
    if (!final.answer) throw new Error("a learned answer needs an answer before it can be confirmed");

    const raw = JSON.parse(readFileSync(profileFile, "utf8")) as Record<string, unknown>;
    const answers = Array.isArray(raw.answers) ? (raw.answers as { question?: string }[]) : [];
    const next = { ...raw, answers: [...answers.filter((a) => a?.question !== final.question), final] };
    ProfileSchema.parse(next);

    writeAtomic(profileFile, JSON.stringify(next, null, 2) + "\n");
    writeAtomic(pendingFile, JSON.stringify({ pending: pending.filter((p) => p.id !== id) }, null, 2) + "\n");
    return final;
  });
}
