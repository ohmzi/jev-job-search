/**
 * The dashboard's routes over HTTP on this machine. An answer the Easy Apply walk learned is
 * confirmed only with the token the page was given, and a blank answer or an id that is no
 * longer waiting is refused with a message the page can show.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addLearned, loadLearned } from "../src/answers/learned.js";
import { PATHS } from "../src/config.js";
import { createReportServer } from "../src/report/server.js";

const TOKEN = "made-up-token-for-the-test";
const QUESTION = "Which area of engineering are you most interested in?";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

/** A pending store and a profile beside it, both in a fresh temp dir. */
const files = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jev-report-server-"));
  const profile = path.join(dir, "profile.json");
  writeFileSync(profile, readFileSync(PATHS.profileExample, "utf8"));
  return { dir, pending: path.join(dir, "learned.json"), profile };
};

type Started = { close: () => Promise<void> };
const started: Started[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (started.length) await started.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A server with one learned answer waiting, and a known token. */
const open = async () => {
  const f = files();
  dirs.push(f.dir);
  addLearned([{ jobId: "job-1", company: "Acme", title: "Software Intern", question: QUESTION, answer: "Backend.", options: ["Frontend", "Backend"] }], f.pending);
  const id = loadLearned(f.pending).pending[0]!.id;
  const server = await createReportServer(await freePort(), { token: TOKEN, learned: f.pending, profile: f.profile });
  started.push(server);
  return { ...f, id, origin: server.address };
};

const confirm = (origin: string, body: unknown, token?: string) =>
  fetch(`${origin}/api/confirm-answer`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { "x-jev-token": token }) },
    body: JSON.stringify(body),
  });

describe("confirming a learned answer from the page", () => {
  it("confirms a learned answer for the page's token only", async () => {
    const s = await open();

    expect((await confirm(s.origin, { id: s.id, answer: "Backend, mostly." })).status).toBe(403);
    expect((await confirm(s.origin, { id: s.id, answer: "Backend, mostly." }, "made-up-token-for-the-tesX")).status).toBe(403);

    const res = await confirm(s.origin, { id: s.id, answer: "Backend, mostly." }, TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ question: QUESTION, answer: "Backend, mostly." });

    const profile = JSON.parse(readFileSync(s.profile, "utf8")) as { answers: { question: string; answer: string }[] };
    expect(profile.answers).toContainEqual({ question: QUESTION, answer: "Backend, mostly." });
    expect(loadLearned(s.pending).pending).toEqual([]);
  });

  it("refuses a blank answer with a message and keeps the entry waiting", async () => {
    const s = await open();
    const before = readFileSync(s.profile, "utf8");

    const res = await confirm(s.origin, { id: s.id, answer: "   " }, TOKEN);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/answer/i);

    expect(readFileSync(s.profile, "utf8")).toBe(before);
    expect(loadLearned(s.pending).pending.map((p) => p.id)).toEqual([s.id]);
  });

  it("refuses an id that is no longer waiting", async () => {
    const s = await open();
    const before = readFileSync(s.profile, "utf8");

    const res = await confirm(s.origin, { id: "not-a-real-id", answer: "Backend." }, TOKEN);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/waiting/i);

    expect(readFileSync(s.profile, "utf8")).toBe(before);
    expect(loadLearned(s.pending).pending.map((p) => p.id)).toEqual([s.id]);
  });
});
