import { describe, expect, it, vi } from "vitest";
import { JevClient, JevError } from "../src/jev/client.js";
import { choice, noul, score, scoreToUnit } from "../src/jev/questions.js";

const questions = { a: noul("a?"), b: choice("b?", { x: "X", y: "Y" }), c: score("c?", ["lo", "mid", "hi"]) };
const complete = {
  answers: {
    a: { type: "noul", noul: 0.9 },
    b: { type: "choice", choice: "x", probabilities: { x: 0.8, y: 0.2 }, confidence: 0.6 },
    c: { type: "score", score: 1.5, legend: {}, probabilities: {}, confidence: 0.5 },
  },
};
const reply = (text: string, usage = { prompt_tokens: 100, completion_tokens: 10 }) => ({
  id: "ds-1",
  model: "deepseek-flash",
  choices: [{ message: { role: "assistant", content: text } }],
  usage,
});
const res = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("JevClient on DeepSeek", () => {
  it("posts the typed questions to DeepSeek in JSON mode and validates the answers", async () => {
    const fetchImpl = vi.fn(async () => res(200, reply(JSON.stringify(complete))));
    const jev = new JevClient({ apiKey: "sk-test", fetchImpl, usageLog: null });
    const answers = await jev.decide({ hello: "world" }, questions);

    expect(answers.a).toEqual({ type: "noul", noul: 0.9 });
    expect(answers.b).toEqual({ type: "choice", choice: "x", probabilities: { x: 0.8, y: 0.2 }, confidence: 0.6 });
    expect(answers.c).toEqual({ type: "score", score: 1.5, legend: {}, probabilities: {}, confidence: 0.5 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("deepseek-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain('"hello"');
    expect(body.messages[1].content).toContain('"b"');
    expect(jev.usage.calls).toBe(1);
    expect(jev.usage.inputTokens).toBe(100);
    expect(jev.usage.outputTokens).toBe(10);
    expect(jev.usage.costUsd).toBeCloseTo(0.0000322, 10);
  });

  it("accepts a bare number, a bare choice and a bare score, with no claimed confidence", async () => {
    const body = { answers: { a: 0.9, b: "x", c: 1 } };
    const jev = new JevClient({ apiKey: "k", fetchImpl: async () => res(200, reply(JSON.stringify(body))), usageLog: null });
    const answers = await jev.decide("s", questions);
    expect(answers.a).toEqual({ type: "noul", noul: 0.9 });
    expect(answers.b).toEqual({ type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 0 });
    expect(answers.c).toEqual({ type: "score", score: 1, legend: {}, probabilities: {}, confidence: 0 });
  });

  it("clamps a probability and a score into their ranges", async () => {
    const body = { answers: { a: 1.7, b: { choice: "y", confidence: 0.4 }, c: 99 } };
    const jev = new JevClient({ apiKey: "k", fetchImpl: async () => res(200, reply(JSON.stringify(body))), usageLog: null });
    const answers = await jev.decide("s", questions);
    expect(answers.a).toEqual({ type: "noul", noul: 1 });
    expect(answers.b).toMatchObject({ choice: "y", confidence: 0.4 });
    expect(answers.c).toMatchObject({ score: 2, confidence: 0 });
  });

  it("repairs one missing answer, then succeeds", async () => {
    const missing = { answers: { a: complete.answers.a, c: complete.answers.c } };
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(200, reply(JSON.stringify(missing)))).mockResolvedValueOnce(res(200, reply(JSON.stringify(complete))));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
    await expect(jev.decide("s", questions)).resolves.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.messages.at(-1).content).toMatch(/missing|invalid/i);
  });

  it("fails after the repair when an answer is still missing", async () => {
    const missing = { answers: { a: complete.answers.a, c: complete.answers.c } };
    const fetchImpl = vi.fn(async () => res(200, reply(JSON.stringify(missing))));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
    await expect(jev.decide("s", questions)).rejects.toBeInstanceOf(JevError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a choice that is not one of the question's options", async () => {
    const bad = { answers: { ...complete.answers, b: { ...complete.answers.b, choice: "z" } } };
    const fetchImpl = vi.fn(async () => res(200, reply(JSON.stringify(bad))));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
    await expect(jev.decide("s", questions)).rejects.toThrow(/choices|options/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(429, "slow down")).mockResolvedValueOnce(res(502, "bad")).mockResolvedValueOnce(res(200, reply(JSON.stringify(complete))));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
    await expect(jev.decide("s", questions)).resolves.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx and redacts the key from the error", async () => {
    const fetchImpl = vi.fn(async () => res(400, "bad key sk-abcdef123456"));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
    await expect(jev.decide("s", questions)).rejects.toThrow(/sk-\[redacted\]/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to spend past the cap", async () => {
    const jev = new JevClient({ apiKey: "k", fetchImpl: async () => res(200, reply(JSON.stringify(complete))), usageLog: null, spendCapUsd: 0.000001 });
    await jev.decide("s", questions);
    await expect(jev.decide("s", questions)).rejects.toThrow(/spend cap/);
  });

  it("requires a DEEPSEEK_API_KEY", () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => new JevClient({ usageLog: null })).toThrow(/DEEPSEEK_API_KEY/);
    if (saved) process.env.DEEPSEEK_API_KEY = saved;
  });

  it("falls back to the default model when DEEPSEEK_MODEL is empty", async () => {
    const saved = process.env.DEEPSEEK_MODEL;
    process.env.DEEPSEEK_MODEL = "";
    try {
      const fetchImpl = vi.fn(async () => res(200, reply(JSON.stringify(complete))));
      const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
      await jev.decide("s", questions);
      const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(body.model).toBe("deepseek-flash");
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_MODEL;
      else process.env.DEEPSEEK_MODEL = saved;
    }
  });

  it("omits temperature for the reasoner model, which does not take one", async () => {
    const fetchImpl = vi.fn(async () => res(200, reply(JSON.stringify(complete))));
    const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null, model: "deepseek-reasoner" });
    await jev.decide("s", questions);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("deepseek-reasoner");
    expect(body.temperature).toBeUndefined();
  });

  it("takes the model from DEEPSEEK_MODEL", async () => {
    const saved = process.env.DEEPSEEK_MODEL;
    process.env.DEEPSEEK_MODEL = "deepseek-reasoner";
    try {
      const fetchImpl = vi.fn(async () => res(200, reply(JSON.stringify(complete))));
      const jev = new JevClient({ apiKey: "k", fetchImpl, usageLog: null });
      await jev.decide("s", questions);
      const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(body.model).toBe("deepseek-reasoner");
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_MODEL;
      else process.env.DEEPSEEK_MODEL = saved;
    }
  });
});

describe("question builders", () => {
  it("normalizes a score to the unit interval", () => {
    expect(scoreToUnit(0, 5)).toBe(0);
    expect(scoreToUnit(4, 5)).toBe(1);
    expect(scoreToUnit(2, 5)).toBe(0.5);
    expect(scoreToUnit(9, 5)).toBe(1);
  });
  it("rejects a score with one level", () => {
    expect(() => score("x", ["only"])).toThrow();
  });
});
