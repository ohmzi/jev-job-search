import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addLearned, confirmLearned, loadLearned, type NewPending } from "../src/answers/learned.js";
import { PATHS } from "../src/config.js";

const QUESTION = "Which area of engineering are you most interested in?";

/** A pending store and a profile beside it, both in a fresh temp dir. */
const files = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-learned-"));
  const profile = path.join(dir, "profile.json");
  writeFileSync(profile, readFileSync(PATHS.profileExample, "utf8"));
  return { pending: path.join(dir, "learned.json"), profile };
};

const row = (over: Partial<NewPending> = {}): NewPending => ({
  jobId: "job-1",
  company: "Acme",
  title: "Software Intern",
  question: QUESTION,
  answer: "Backend.",
  options: ["Frontend", "Backend"],
  ...over,
});

describe("the pending learned answers", () => {
  it("keeps one pending entry per question", () => {
    const f = files();
    expect(addLearned([row()], f.pending)).toBe(1);
    expect(addLearned([row({ jobId: "job-2", company: "Globex", answer: "Frontend." })], f.pending)).toBe(0);

    const { pending } = loadLearned(f.pending);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ jobId: "job-1", company: "Acme", question: QUESTION, answer: "Backend.", options: ["Frontend", "Backend"] });
    expect(pending[0]!.id).toBeTruthy();
    expect(pending[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("dedupes inside one batch as well", () => {
    const f = files();
    expect(addLearned([row(), row({ jobId: "job-2" }), row({ question: "Why this role?", options: [] })], f.pending)).toBe(2);
    expect(loadLearned(f.pending).pending.map((p) => p.question)).toEqual([QUESTION, "Why this role?"]);
  });

  it("confirming writes the profile and clears the entry", () => {
    const f = files();
    addLearned([row()], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;

    expect(confirmLearned(id, "Backend, mostly.", f)).toEqual({ question: QUESTION, answer: "Backend, mostly." });

    const profile = JSON.parse(readFileSync(f.profile, "utf8")) as { answers: { question: string; answer: string }[] };
    expect(profile.answers).toContainEqual({ question: QUESTION, answer: "Backend, mostly." });
    expect(loadLearned(f.pending).pending).toEqual([]);
  });

  it("replaces a standing answer with the same question instead of adding a second", () => {
    const f = files();
    const before = (JSON.parse(readFileSync(f.profile, "utf8")) as { answers: { question: string; answer: string }[] }).answers;
    expect(before.some((a) => a.question === QUESTION)).toBe(true);

    addLearned([row()], f.pending);
    confirmLearned(loadLearned(f.pending).pending[0]!.id, "Full stack.", f);

    const after = (JSON.parse(readFileSync(f.profile, "utf8")) as { answers: { question: string; answer: string }[] }).answers;
    expect(after.filter((a) => a.question === QUESTION)).toEqual([{ question: QUESTION, answer: "Full stack." }]);
  });

  it("a confirmed answer with no option is stored but not forced onto a radio", () => {
    const f = files();
    addLearned([row({ question: "Do you need a visa?", answer: "Yes.", options: [] })], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;

    confirmLearned(id, "Yes.", f);

    const profile = JSON.parse(readFileSync(f.profile, "utf8")) as { answers: Record<string, string>[] };
    const stored = profile.answers.find((a) => a.question === "Do you need a visa?");
    expect(stored).toEqual({ question: "Do you need a visa?", answer: "Yes." });
    expect(Object.keys(stored ?? {})).toEqual(["question", "answer"]);
  });

  it("refuses an id that is not waiting", () => {
    expect(() => confirmLearned("not-a-real-id", "Yes.", files())).toThrow(/No learned answer/);
  });

  it("refuses a blank answer and writes nothing", () => {
    const f = files();
    addLearned([row()], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;
    const before = readFileSync(f.profile, "utf8");

    expect(() => confirmLearned(id, "", f)).toThrow(/needs an answer/);
    expect(readFileSync(f.profile, "utf8")).toBe(before);
    expect(loadLearned(f.pending).pending.map((p) => p.id)).toEqual([id]);
  });

  it("refuses a whitespace-only answer and writes nothing", () => {
    const f = files();
    addLearned([row()], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;
    const before = readFileSync(f.profile, "utf8");

    expect(() => confirmLearned(id, "   ", f)).toThrow(/needs an answer/);
    expect(readFileSync(f.profile, "utf8")).toBe(before);
    expect(loadLearned(f.pending).pending.map((p) => p.id)).toEqual([id]);
  });

  it("refuses a pending answer with no question and writes nothing", () => {
    const f = files();
    addLearned([row({ question: "   " })], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;
    const before = readFileSync(f.profile, "utf8");

    expect(() => confirmLearned(id, "Yes.", f)).toThrow(/needs a question/);
    expect(readFileSync(f.profile, "utf8")).toBe(before);
    expect(loadLearned(f.pending).pending.map((p) => p.id)).toEqual([id]);
  });

  it("refuses an authorization question and writes nothing", () => {
    const f = files();
    addLearned([row({ question: "Are you authorized to work in the United States?" })], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;
    const before = readFileSync(f.profile, "utf8");

    expect(() => confirmLearned(id, "Yes.", f)).toThrow(/right to work/);
    expect(readFileSync(f.profile, "utf8")).toBe(before);
    expect(loadLearned(f.pending).pending.map((p) => p.id)).toEqual([id]);
  });

  it("refuses a sponsorship question and writes nothing", () => {
    const f = files();
    addLearned([row({ question: "Will you require sponsorship to work in the United States?" })], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;
    const before = readFileSync(f.profile, "utf8");

    expect(() => confirmLearned(id, "No.", f)).toThrow(/right to work/);
    expect(readFileSync(f.profile, "utf8")).toBe(before);
    expect(loadLearned(f.pending).pending.map((p) => p.id)).toEqual([id]);
  });

  it("does not write a profile that does not validate, and keeps the entry", () => {
    const f = files();
    addLearned([row()], f.pending);
    const id = loadLearned(f.pending).pending[0]!.id;
    const broken = JSON.parse(readFileSync(f.profile, "utf8")) as Record<string, unknown>;
    delete broken.email;
    writeFileSync(f.profile, JSON.stringify(broken));

    expect(() => confirmLearned(id, "Backend.", f)).toThrow();
    expect(readFileSync(f.profile, "utf8")).not.toContain("Backend.");
    expect(loadLearned(f.pending).pending.map((p) => p.id)).toEqual([id]);
  });
});
