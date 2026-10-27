import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AccessControl } from "../src/auth/access.js";
import { currentPeriod, MemoryLedger, SqliteLedger } from "../src/auth/ledger.js";
import { TokenBucket } from "../src/auth/rate-limit.js";
import { ResponseCache } from "../src/cache/cache.js";
import { MemoryCacheStore } from "../src/cache/memory-store.js";
import type { GatewayConfig } from "../src/config/schema.js";
import { silentLogger } from "../src/logger.js";
import { PriceBook } from "../src/pricing.js";
import { startMockUpstream, type MockUpstream } from "../src/testing/mock-upstream.js";
import { configFrom, json, post, readSSE } from "./helpers.js";

const yaml = `
upstreams:
  oai: { type: openai, baseUrl: "{{openai}}" }
  ant: { type: anthropic, baseUrl: "{{anthropic}}" }
models:
  gpt: { targets: [oai/gpt-test] }
  claude: { targets: [ant/claude-haiku-5-5] }
auth:
  keys:
    - { name: team-a, key: "\${KEY_A}", budgetUsdMonthly: 0.05 }
    - { name: limited, key: sk-gw-limited-000000, requestsPerMinute: 2 }
    - { name: gpt-only, key: sk-gw-gpt-only-00000, models: [gpt] }
pricing:
  gpt-test: { input: 1000, output: 2000 }
cache: { enabled: true }
`;

let mock: MockUpstream;
let config: GatewayConfig;
let now: Date;
let ledger: MemoryLedger;
let access: AccessControl;
let app: ReturnType<typeof createApp>;
const KEY_A = "sk-gw-team-a-secret-123";

beforeAll(async () => {
  mock = await startMockUpstream();
  config = configFrom(yaml, { openai: mock.url, anthropic: mock.url }, { KEY_A });
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.requests.length = 0;
  now = new Date("2026-10-15T12:00:00Z");
  ledger = new MemoryLedger();
  access = new AccessControl(config, ledger, () => now);
  const cache = new ResponseCache(config.cache, new MemoryCacheStore(), undefined, silentLogger);
  app = createApp({ config, logger: silentLogger, access, cache });
});

const chat = (key: string | undefined, extra: Record<string, unknown> = {}) =>
  post(app, "/v1/chat/completions", { model: "gpt", messages: [{ role: "user", content: "hello" }], ...extra }, key ? { authorization: `Bearer ${key}` } : {});

describe("virtual keys", () => {
  it("rejects missing and unknown keys in the client's format", async () => {
    const missing = await chat(undefined);
    expect(missing.status).toBe(401);
    expect((await json(missing)).error.code).toBe("invalid_api_key");
    const wrong = await post(app, "/v1/messages", { model: "claude", max_tokens: 5, messages: [{ role: "user", content: "x" }] }, { "x-api-key": "sk-nope" });
    expect(wrong.status).toBe(401);
    expect(await json(wrong)).toEqual({ type: "error", error: { type: "authentication_error", message: "invalid API key" } });
    expect(mock.requests).toHaveLength(0);
  });

  it("accepts Bearer (OpenAI SDK) and x-api-key (Anthropic SDK)", async () => {
    expect((await chat(KEY_A)).status).toBe(200);
    const res = await post(app, "/v1/messages", { model: "claude", max_tokens: 5, messages: [{ role: "user", content: "x" }] }, { "x-api-key": KEY_A });
    expect(res.status).toBe(200);
    // the client's key is never forwarded upstream
    expect(mock.requests.every((r) => r.headers["x-api-key"] !== KEY_A && r.headers.authorization !== `Bearer ${KEY_A}`)).toBe(true);
  });

  it("enforces per-key model allowlists", async () => {
    expect((await post(app, "/v1/messages", { model: "claude", max_tokens: 5, messages: [{ role: "user", content: "x" }] }, { "x-api-key": "sk-gw-gpt-only-00000" })).status).toBe(403);
    expect((await chat("sk-gw-gpt-only-00000")).status).toBe(200);
  });

  it("allows anonymous traffic only when no keys are configured", async () => {
    const open = configFrom(`upstreams: { oai: { type: openai, baseUrl: "{{openai}}" } }\nmodels: { gpt: { targets: [oai/x] } }`, { openai: mock.url });
    const res = await post(createApp({ config: open, logger: silentLogger }), "/v1/chat/completions", { model: "gpt", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(200);
  });
});

describe("cost accounting and budgets", () => {
  it("prices each response from upstream usage and reports cost and remaining budget", async () => {
    const res = await chat(KEY_A, { max_tokens: 5 });
    const body = await json(res);
    const { prompt_tokens, completion_tokens } = body.usage;
    const expected = (prompt_tokens * 1000 + completion_tokens * 2000) / 1e6;
    expect(Number(res.headers.get("x-gateway-cost-usd"))).toBeCloseTo(expected, 8);
    expect(Number(res.headers.get("x-gateway-budget-remaining-usd"))).toBeCloseTo(0.05 - expected, 6);
    expect(await access.spent("team-a")).toBeCloseTo(expected, 10);
  });

  it("rejects requests once the monthly budget is spent (402) and resets next month", async () => {
    while ((await access.spent("team-a")) < 0.05) expect((await chat(KEY_A, { messages: [{ role: "user", content: `q${Math.random()}` }] })).status).toBe(200);
    const upstreamCalls = mock.requests.length;

    const oai = await chat(KEY_A, { messages: [{ role: "user", content: "one more" }] });
    expect(oai.status).toBe(402);
    expect((await json(oai)).error).toMatchObject({ type: "insufficient_quota", code: "budget_exceeded" });
    const ant = await post(app, "/v1/messages", { model: "claude", max_tokens: 5, messages: [{ role: "user", content: "x" }] }, { "x-api-key": KEY_A });
    expect(ant.status).toBe(402);
    expect((await json(ant)).error.type).toBe("billing_error");
    expect(mock.requests.length).toBe(upstreamCalls);

    now = new Date("2026-11-01T00:00:01Z");
    expect((await chat(KEY_A, { messages: [{ role: "user", content: "new month" }] })).status).toBe(200);
  });

  it("still serves cache hits after the budget is spent, at zero cost", async () => {
    const req = { temperature: 0, messages: [{ role: "user", content: "cached question" }] };
    await json(await chat(KEY_A, req));
    await new Promise((r) => setTimeout(r, 5));
    await ledger.add("team-a", currentPeriod(now), 1);
    const hit = await chat(KEY_A, req);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("x-gateway-cache")).toBe("hit");
    expect(hit.headers.get("x-gateway-cost-usd")).toBe("0");
  });

  it("charges streamed responses when the stream completes and reports cost in a trailing SSE comment", async () => {
    const res = await chat(KEY_A, { stream: true });
    const text = await res.text();
    const m = /^: x-gateway-cost-usd=([\d.]+)$/m.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(await access.spent("team-a")).toBeCloseTo(Number(m![1]), 8);
  });

  it("counts unpriced models as $0 and omits the cost header", async () => {
    const res = await post(app, "/v1/chat/completions", { model: "oai/unpriced-model", messages: [{ role: "user", content: "x" }] }, { authorization: `Bearer ${KEY_A}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-cost-usd")).toBeNull();
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the bucket is empty, and refills over time", async () => {
    const key = "sk-gw-limited-000000";
    expect((await chat(key)).headers.get("x-ratelimit-remaining-requests")).toBe("1");
    expect((await chat(key)).status).toBe(200);
    const limited = await chat(key);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect((await json(limited)).error.code).toBe("rate_limit_exceeded");

    const ant = await post(app, "/v1/messages", { model: "gpt", max_tokens: 1, messages: [{ role: "user", content: "x" }] }, { "x-api-key": key });
    expect((await json(ant)).error.type).toBe("rate_limit_error");

    now = new Date(now.getTime() + 30_000);
    expect((await chat(key)).status).toBe(200);
  });
});

describe("token bucket", () => {
  it("allows a burst, then refills continuously", () => {
    const b = new TokenBucket(60, 3, 0);
    expect([b.take(0), b.take(0), b.take(0)].every((r) => r.ok)).toBe(true);
    const denied = b.take(0);
    expect(denied).toMatchObject({ ok: false, retryAfterMs: 1000 });
    expect(b.take(500).ok).toBe(false);
    expect(b.take(1000).ok).toBe(true);
    expect(b.take(100_000).remaining).toBe(2); // capped at capacity
  });
});

describe("pricing", () => {
  const book = new PriceBook({ "gpt-test*": { input: 1, output: 2 }, "gpt-test-large": { input: 10, output: 20 } });
  it("uses built-in Claude prices and charges prompt-cache reads at the cached rate", () => {
    expect(book.cost("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 })).toBe(24);
    expect(book.cost("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 })).toBeCloseTo(1.1, 10);
  });
  it("applies long-context tiers", () => {
    expect(book.cost("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 0, cachedInputTokens: 0 })).toBeCloseTo(0.01, 10);
    expect(book.cost("claude-haiku-5-5", { inputTokens: 200_000, outputTokens: 0, cachedInputTokens: 0 })).toBeCloseTo(0.1, 10);
  });
  it("matches exact ids before the longest prefix wildcard", () => {
    expect(book.cost("gpt-test-large", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 })).toBe(10);
    expect(book.cost("gpt-test-mini", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 })).toBe(1);
    expect(book.cost("mystery", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 })).toBeUndefined();
  });
});

describe("sqlite ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-ledger-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("accumulates spend per key and period and survives reopening", async () => {
    const path = join(dir, "spend.db");
    const a = await SqliteLedger.open(path);
    await a.add("k", "2026-10", 0.25);
    expect(await a.add("k", "2026-10", 0.5)).toBeCloseTo(0.75);
    await a.add("k", "2026-11", 1);
    await a.close();
    const b = await SqliteLedger.open(path);
    expect(await b.get("k", "2026-10")).toBeCloseTo(0.75);
    expect(await b.get("other", "2026-10")).toBe(0);
    await b.close();
  });
});

describe("config validation for keys", () => {
  it("rejects duplicate key names and secrets", () => {
    expect(() =>
      configFrom(`
upstreams: { oai: { type: openai, baseUrl: "{{openai}}" } }
auth: { keys: [ { name: a, key: s1 }, { name: a, key: s1 } ] }
`),
    ).toThrow(/duplicate key name "a"[\s\S]*duplicate key secret/);
  });
});
