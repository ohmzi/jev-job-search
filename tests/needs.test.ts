import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addLearned, type NewPending } from "../src/answers/learned.js";
import { buildNeeds } from "../src/report/needs.js";

const QUESTION = "Which area of engineering are you most interested in?";

/** A learned store and an inbox beside it, both in a fresh temp dir. */
const files = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-needs-"));
  return { learned: path.join(dir, "learned.json"), inbox: path.join(dir, "inbox.json") };
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

describe("the needs you section", () => {
  it("lists a learned answer as something to confirm, once", () => {
    const f = files();
    addLearned([row({ jobId: "job-1", company: "Acme", answer: "Backend." })], f.learned);
    addLearned([row({ jobId: "job-2", company: "Globex", answer: "Frontend." })], f.learned);

    // No queue entry: the answer waits on its own, whichever job raised it.
    const needs = buildNeeds([], { learnedFile: f.learned, inboxFile: f.inbox });

    expect(needs.answers).toHaveLength(1);
    expect(needs.answers[0]).toMatchObject({
      jobId: "job-1",
      company: "Acme",
      title: "Software Intern",
      question: QUESTION,
      answer: "Backend.",
      options: ["Frontend", "Backend"],
    });
  });

  it("has nothing to confirm before an answer is learned", () => {
    const f = files();
    expect(buildNeeds([], { learnedFile: f.learned, inboxFile: f.inbox }).answers).toEqual([]);
  });
});
