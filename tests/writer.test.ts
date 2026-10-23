import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writerCostUsd } from "../src/answers/resolve.js";

describe("the writer's price", () => {
  it("prices a call from DeepSeek's token counts, cache hits at the cheaper rate", () => {
    expect(writerCostUsd({ prompt_tokens: 1_000_000, prompt_cache_miss_tokens: 1_000_000 })).toBeCloseTo(0.28, 5);
    expect(writerCostUsd({ prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, completion_tokens: 100_000 })).toBeCloseTo(0.028 + 0.042, 5);
    expect(writerCostUsd({})).toBe(0);
  });
});

describe("the DeepSeek writer call", () => {
  const realFetch = globalThis.fetch;
  const savedKey = process.env.DEEPSEEK_API_KEY;
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = ["sk", "test"].join("-");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
  });
  const ok = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1010, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });

  it("sends the system prompt first, asks for a JSON object, reads the text back and records the usage", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return ok('{"verdict":"ready"}');
    }) as typeof fetch;
    const { askWriter, writerUsage } = await import("../src/answers/resolve.js");
    const before = writerUsage.calls;
    const text = await askWriter("hello", "Reply as JSON.");
    expect(text).toBe('{"verdict":"ready"}');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${process.env.DEEPSEEK_API_KEY}`);
    const body = JSON.parse(String(seen[0]?.init.body)) as { messages: { role: string; content: string }[]; response_format: { type: string }; max_tokens: number };
    expect(body.messages).toEqual([
      { role: "system", content: "Reply as JSON." },
      { role: "user", content: "hello" },
    ]);
    expect(body.response_format.type).toBe("json_object");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(writerUsage.calls).toBe(before + 1);
  });

  it("tries again after a 503 and then answers", async () => {
    let calls = 0;
    globalThis.fetch = (async () => (++calls === 1 ? new Response("busy", { status: 503 }) : ok("{}"))) as typeof fetch;
    const { askWriter } = await import("../src/answers/resolve.js");
    await expect(askWriter("hello", "x")).resolves.toBe("{}");
    expect(calls).toBe(2);
  });

  it("treats a reply cut off at the token limit as a failure, not as text a parser should try to read", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"ready","answers":[{"selector":"#q1"' }, finish_reason: "length" }],
          usage: { prompt_tokens: 10, completion_tokens: 100 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const { askWriter } = await import("../src/answers/resolve.js");
    await expect(askWriter("hello", "x")).rejects.toThrow(/cut off at the .*token limit/);
    expect(calls).toBe(1);
  });

  it("explains a refusal without the key and does not retry it", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), { status: 401 });
    }) as typeof fetch;
    const { askWriter } = await import("../src/answers/resolve.js");
    const err = await askWriter("hello", "x").then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/401: Authentication Fails/);
    expect(err?.message).not.toContain(process.env.DEEPSEEK_API_KEY ?? "never");
    expect(calls).toBe(1);
  });

  it("says so when there is no key", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const { askWriter } = await import("../src/answers/resolve.js");
    await expect(askWriter("hello", "x")).rejects.toThrow(/DEEPSEEK_API_KEY is not set/);
  });
});
