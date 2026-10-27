import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import { startMockUpstream, type MockUpstream } from "../src/testing/mock-upstream.js";
import { backoff, parseRetryAfter } from "../src/upstream/executor.js";
import { configFrom, json, post, readSSE, sseJson } from "./helpers.js";

let primary: MockUpstream;
let secondary: MockUpstream;
let sleeps: number[];
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  primary = await startMockUpstream();
  secondary = await startMockUpstream();
  const config = configFrom(
    `
upstreams:
  primary: { type: openai, baseUrl: "{{openai}}", timeoutMs: 150 }
  backup: { type: anthropic, baseUrl: "{{anthropic}}" }
models:
  chain: { targets: [primary/model-a, backup/claude-haiku-5-5] }
  chain-anthropic-first: { targets: [backup/claude-haiku-5-5, primary/model-a] }
retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 2000 }
`,
    { openai: primary.url, anthropic: secondary.url },
  );
  app = createApp({ config, logger: silentLogger, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
});
afterAll(async () => {
  await primary.close();
  await secondary.close();
});
beforeEach(() => {
  sleeps = [];
  for (const m of [primary, secondary]) {
    m.requests.length = 0;
    m.setHandler(undefined);
  }
});

const chat = (extra: Record<string, unknown> = {}) => post(app, "/v1/chat/completions", { model: "chain", messages: [{ role: "user", content: "hello" }], ...extra });

describe("fallback chain", () => {
  it("retries a 503 with backoff, then falls over to the next target", async () => {
    primary.setHandler(() => ({ status: 503, json: { error: { message: "overloaded" } } }));
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream")).toBe("backup");
    expect(res.headers.get("x-gateway-attempts")).toBe("3");
    expect(primary.requests).toHaveLength(2);
    expect(secondary.requests).toHaveLength(1);
    // one backoff between the two primary attempts (base 100ms * random 0.5); none between targets
    expect(sleeps).toEqual([50]);
    expect((await json(res)).choices[0].message.content).toBe("echo: hello");
  });

  it("recovers on the same target when a retry succeeds, honouring Retry-After", async () => {
    let calls = 0;
    primary.setHandler(() => (++calls === 1 ? { status: 429, headers: { "retry-after": "1" }, json: { error: { message: "slow down" } } } : undefined));
    const res = await chat();
    expect(res.headers.get("x-gateway-upstream")).toBe("primary");
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
    expect(sleeps).toEqual([1000]);
  });

  it("falls over immediately when Retry-After exceeds maxDelayMs", async () => {
    primary.setHandler(() => ({ status: 429, headers: { "retry-after": "60" }, json: { error: { message: "quota" } } }));
    const res = await chat();
    expect(res.headers.get("x-gateway-upstream")).toBe("backup");
    expect(primary.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("treats timeouts and dropped connections as retryable", async () => {
    let calls = 0;
    primary.setHandler(() => (++calls === 1 ? { hang: true } : { drop: true }));
    const res = await chat();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream")).toBe("backup");
    expect(calls).toBe(2);
  });

  it("does not fall back on non-retryable client errors", async () => {
    primary.setHandler(() => ({ status: 400, json: { error: { message: "bad tool schema", type: "invalid_request_error" } } }));
    const res = await chat();
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toBe("bad tool schema");
    expect(secondary.requests).toHaveLength(0);
  });

  it("returns 429 in the client's format when every target is rate limited", async () => {
    const limited = () => ({ status: 429, json: { error: { message: "rate limited" } } });
    primary.setHandler(limited);
    secondary.setHandler(limited);
    const res = await post(app, "/v1/messages", { model: "chain", max_tokens: 10, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toMatch(/primary\/model-a#1: 429/);
  });

  it("returns 502 when every target fails with server errors", async () => {
    primary.setHandler(() => ({ status: 500, json: {} }));
    secondary.setHandler(() => ({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }));
    const res = await chat();
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe("upstream_error");
    expect(primary.requests.length + secondary.requests.length).toBe(4);
  });

  it("skips targets that cannot express the request", async () => {
    const res = await post(app, "/v1/chat/completions", { model: "chain-anthropic-first", n: 2, messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream")).toBe("primary");
    expect(secondary.requests).toHaveLength(0);
  });

  it("falls back before the first byte of a streaming response", async () => {
    primary.setHandler(() => ({ status: 502, json: { error: { message: "bad gateway" } } }));
    const res = await chat({ stream: true });
    expect(res.headers.get("x-gateway-upstream")).toBe("backup");
    const chunks = sseJson(await readSSE(res));
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("echo: hello");
  });
});

describe("backoff", () => {
  const retry = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, retryOn: [] };
  it("grows exponentially, is capped, and applies full jitter", () => {
    expect([1, 2, 3, 4, 5].map((a) => backoff(retry, a, undefined, () => 1))).toEqual([100, 200, 400, 800, 1000]);
    expect(backoff(retry, 3, undefined, () => 0)).toBe(0);
  });
  it("never waits less than Retry-After (within the cap)", () => {
    expect(backoff(retry, 1, 700, () => 0.1)).toBe(700);
    expect(backoff(retry, 1, 5000, () => 0.1)).toBe(1000);
  });
  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
