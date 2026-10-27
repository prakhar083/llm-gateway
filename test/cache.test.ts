import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ResponseCache } from "../src/cache/cache.js";
import { HashingEmbedder, type Embedder } from "../src/cache/embedder.js";
import { MemoryCacheStore } from "../src/cache/memory-store.js";
import { SqliteCacheStore } from "../src/cache/sqlite-store.js";
import { dot, normalize, type CacheStore } from "../src/cache/store.js";
import type { GatewayConfig } from "../src/config/schema.js";
import { silentLogger } from "../src/logger.js";
import { startMockUpstream, type MockUpstream } from "../src/testing/mock-upstream.js";
import { configFrom, json, post, readSSE, sseJson } from "./helpers.js";

/** Deterministic embedder: known phrases map to fixed directions, anything else to a hashed one-hot axis. */
class FakeEmbedder implements Embedder {
  readonly id = "fake";
  calls: string[] = [];
  fail = false;
  private table: Record<string, number[]> = {
    "what is the capital of france?": [1, 0, 0, 0],
    "what's the capital city of france": [0.97, 0.24, 0, 0],
    "how do i bake sourdough bread?": [0, 0, 1, 0],
  };
  async embed(text: string) {
    this.calls.push(text);
    if (this.fail) throw new Error("embedding service down");
    const known = this.table[text.toLowerCase()];
    const v = new Array(64).fill(0);
    if (known) known.forEach((x, i) => (v[i] = x));
    else v[4 + ([...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 60)] = 1;
    return normalize(v);
  }
}

const yaml = `
upstreams:
  oai: { type: openai, baseUrl: "{{openai}}" }
  ant: { type: anthropic, baseUrl: "{{anthropic}}" }
models:
  gpt: { targets: [oai/gpt-test] }
  claude: { targets: [ant/claude-haiku-5-5] }
cache:
  enabled: true
  ttlSeconds: 60
  semantic: { enabled: true, threshold: 0.9 }
`;

let mock: MockUpstream;
let config: GatewayConfig;
let embedder: FakeEmbedder;
let cache: ResponseCache;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  mock = await startMockUpstream();
  config = configFrom(yaml, { openai: mock.url, anthropic: mock.url });
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.requests.length = 0;
  mock.setHandler(undefined);
  embedder = new FakeEmbedder();
  cache = new ResponseCache(config.cache, new MemoryCacheStore(), embedder, silentLogger);
  app = createApp({ config, logger: silentLogger, cache });
});

const ask = (content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(app, "/v1/chat/completions", { model: "gpt", temperature: 0, messages: [{ role: "user", content }], ...extra }, headers);

/** Let fire-and-forget cache writes settle. */
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("exact cache", () => {
  it("serves an identical deterministic request from cache", async () => {
    const first = await ask("hello there");
    expect(first.headers.get("x-gateway-cache")).toBe("miss");
    const firstBody = await json(first);
    await flush();
    const second = await ask("hello there");
    expect(second.headers.get("x-gateway-cache")).toBe("hit");
    expect(await json(second)).toEqual(firstBody);
    expect(mock.requests).toHaveLength(1);
  });

  it("ignores key order and transport-only fields when hashing", async () => {
    await json(await post(app, "/v1/chat/completions", { temperature: 0, model: "gpt", messages: [{ content: "k", role: "user" }], user: "a" }));
    await flush();
    const res = await post(app, "/v1/chat/completions", { model: "gpt", messages: [{ role: "user", content: "k" }], temperature: 0, user: "b", metadata: { x: "1" } });
    expect(res.headers.get("x-gateway-cache")).toBe("hit");
  });

  it("replays a cached response to a streaming client as SSE, and caches streamed responses", async () => {
    await json(await ask("stream later"));
    await flush();
    const res = await ask("stream later", { stream: true });
    expect(res.headers.get("x-gateway-cache")).toBe("hit");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const chunks = sseJson(await readSSE(res));
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("echo: stream later");
    expect(chunks.some((c) => c.usage)).toBe(false);

    const streamed = await post(app, "/v1/messages", { model: "claude", max_tokens: 20, temperature: 0, stream: true, messages: [{ role: "user", content: "anthropic stream" }] });
    await readSSE(streamed);
    await flush();
    const again = await post(app, "/v1/messages", { model: "claude", max_tokens: 20, temperature: 0, messages: [{ role: "user", content: "anthropic stream" }] });
    expect(again.headers.get("x-gateway-cache")).toBe("hit");
    expect((await json(again)).content[0].text).toBe("echo: anthropic stream");
  });

  it("never caches non-deterministic requests by default", async () => {
    for (const extra of [{ temperature: 0.7 }, { temperature: undefined }]) {
      const a = await ask("creative", extra);
      expect(a.headers.get("x-gateway-cache")).toBe("bypass");
      await flush();
      expect((await ask("creative", extra)).headers.get("x-gateway-cache")).toBe("bypass");
    }
    expect(mock.requests).toHaveLength(4);
  });

  it("caches non-deterministic requests when explicitly configured", async () => {
    const permissive = new ResponseCache({ ...config.cache, cacheNonDeterministic: true }, new MemoryCacheStore(), undefined, silentLogger);
    const a = createApp({ config, logger: silentLogger, cache: permissive });
    await json(await post(a, "/v1/chat/completions", { model: "gpt", temperature: 1.2, messages: [{ role: "user", content: "x" }] }));
    await flush();
    const res = await post(a, "/v1/chat/completions", { model: "gpt", temperature: 1.2, messages: [{ role: "user", content: "x" }] });
    expect(res.headers.get("x-gateway-cache")).toBe("hit");
  });

  it("honours bypass and refresh directives", async () => {
    await json(await ask("directive"));
    await flush();
    expect((await ask("directive", {}, { "x-gateway-cache": "bypass" })).headers.get("x-gateway-cache")).toBe("bypass");
    expect((await ask("directive", {}, { "x-gateway-cache": "refresh" })).headers.get("x-gateway-cache")).toBe("miss");
    expect(mock.requests).toHaveLength(3);
  });

  it("does not cache upstream errors or truncated streams", async () => {
    mock.setHandler(() => ({ status: 400, json: { error: { message: "nope" } } }));
    await ask("err");
    mock.setHandler(() => ({
      sse: [{ data: JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }) }],
    }));
    await readSSE(await ask("cut", { stream: true }));
    mock.setHandler(undefined);
    await flush();
    expect((await ask("err")).headers.get("x-gateway-cache")).toBe("miss");
    expect((await ask("cut")).headers.get("x-gateway-cache")).toBe("miss");
  });

  it("expires entries after the TTL", async () => {
    const req = { model: "gpt", temperature: 0, messages: [{ role: "user" as const, content: "ttl" }] };
    const plan = cache.plan("openai", req, "gpt", "", new Headers());
    await cache.save(plan, { id: "x" } as never, 1_000);
    expect((await cache.lookup(plan, 1_000 + 59_000)).status).toBe("hit");
    expect((await cache.lookup(plan, 1_000 + 61_000)).status).toBe("miss");
  });

  it("partitions entries per virtual key unless shareAcrossKeys is set", () => {
    const req = { model: "gpt", temperature: 0, messages: [{ role: "user" as const, content: "same" }] };
    const h = new Headers();
    expect(cache.plan("openai", req, "gpt", "team-a", h).exactKey).not.toBe(cache.plan("openai", req, "gpt", "team-b", h).exactKey);
    const shared = new ResponseCache({ ...config.cache, shareAcrossKeys: true }, new MemoryCacheStore(), undefined, silentLogger);
    expect(shared.plan("openai", req, "gpt", "team-a", h).exactKey).toBe(shared.plan("openai", req, "gpt", "team-b", h).exactKey);
  });
});

describe("semantic cache", () => {
  it("serves a paraphrase above the similarity threshold and reports the score", async () => {
    const original = await json(await ask("What is the capital of France?"));
    await flush();
    const res = await ask("what's the capital city of France");
    expect(res.headers.get("x-gateway-cache")).toBe("semantic-hit");
    expect(Number(res.headers.get("x-gateway-cache-similarity"))).toBeCloseTo(0.97, 2);
    expect(await json(res)).toEqual(original);
    expect(mock.requests).toHaveLength(1);
    // the stored vector is reused; the miss embeds once, the hit embeds once
    expect(embedder.calls).toHaveLength(2);
  });

  it("misses for unrelated prompts", async () => {
    await json(await ask("What is the capital of France?"));
    await flush();
    expect((await ask("How do I bake sourdough bread?")).headers.get("x-gateway-cache")).toBe("miss");
  });

  it("is scoped by system prompt, prior conversation and model alias", async () => {
    await json(await ask("What is the capital of France?", { messages: [{ role: "system", content: "Answer in French." }, { role: "user", content: "What is the capital of France?" }] }));
    await flush();
    const differentSystem = await ask("x", { messages: [{ role: "system", content: "Answer in German." }, { role: "user", content: "what's the capital city of France" }] });
    expect(differentSystem.headers.get("x-gateway-cache")).toBe("miss");
    const differentHistory = await ask("x", {
      messages: [
        { role: "system", content: "Answer in French." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "what's the capital city of France" },
      ],
    });
    expect(differentHistory.headers.get("x-gateway-cache")).toBe("miss");
    const differentModel = await post(app, "/v1/chat/completions", { model: "claude", temperature: 0, messages: [{ role: "system", content: "Answer in French." }, { role: "user", content: "what's the capital city of France" }] });
    expect(differentModel.headers.get("x-gateway-cache")).toBe("miss");
  });

  it("skips the semantic tier for multimodal or tool-result turns", () => {
    const h = new Headers();
    const image = cache.plan(
      "openai",
      { model: "gpt", temperature: 0, messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] }] },
      "gpt",
      "",
      h,
    );
    expect(image.semantic).toBeUndefined();
    const tool = cache.plan("openai", { model: "gpt", temperature: 0, messages: [{ role: "tool", tool_call_id: "c", content: "42" }] }, "gpt", "", h);
    expect(tool.semantic).toBeUndefined();
  });

  it("degrades to a miss when the embedder fails", async () => {
    embedder.fail = true;
    const res = await ask("What is the capital of France?");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-cache")).toBe("miss");
  });
});

describe.each([
  ["memory", async () => new MemoryCacheStore(100)],
  ["sqlite", async () => SqliteCacheStore.open(join(mkdtempSync(join(tmpdir(), "gw-cache-")), "c.db"))],
])("%s store", (_name, open) => {
  let store: CacheStore;
  beforeEach(async () => {
    store = await open();
  });

  it("stores, expires and returns exact entries", async () => {
    await store.set("k", { value: '{"a":1}', createdAt: 0, expiresAt: 100 });
    expect((await store.get("k", 50))?.value).toBe('{"a":1}');
    expect(await store.get("k", 100)).toBeUndefined();
    expect(await store.get("missing", 0)).toBeUndefined();
  });

  it("returns the best semantic match within a scope above the threshold", async () => {
    const e = (value: string) => ({ value, createdAt: 0, expiresAt: 1_000 });
    await store.semanticAdd("s1", normalize([1, 0, 0]), e("a"));
    await store.semanticAdd("s1", normalize([0.9, 0.1, 0]), e("b"));
    await store.semanticAdd("s2", normalize([0.92, 0.08, 0]), e("other-scope"));
    const q = normalize([0.91, 0.09, 0]);
    const hit = await store.semanticSearch("s1", q, 0.8, 10);
    expect(hit?.entry.value).toBe("b");
    expect(hit!.score).toBeGreaterThan(0.999);
    expect(await store.semanticSearch("s1", normalize([0, 1, 0]), 0.8, 10)).toBeUndefined();
    expect(await store.semanticSearch("s1", q, 0.8, 2_000)).toBeUndefined();
    await store.close();
  });
});

describe("sqlite persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "gw-cache-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("survives reopening the database", async () => {
    const path = join(dir, "persist.db");
    const a = await SqliteCacheStore.open(path);
    await a.set("k", { value: "v", createdAt: 0, expiresAt: Date.now() + 60_000 });
    await a.semanticAdd("s", normalize([1, 2, 3]), { value: "sv", createdAt: 0, expiresAt: Date.now() + 60_000 });
    await a.close();
    const b = await SqliteCacheStore.open(path);
    expect((await b.get("k"))?.value).toBe("v");
    expect((await b.semanticSearch("s", normalize([1, 2, 3]), 0.99))?.entry.value).toBe("sv");
    await b.close();
  });
});

describe("hashing embedder", () => {
  it("is insensitive to case and punctuation, and separates unrelated text", async () => {
    const e = new HashingEmbedder(256);
    const a = await e.embed("How do I reset my password?");
    const b = await e.embed("how do i reset my PASSWORD");
    const c = await e.embed("Recommend a pasta recipe with mushrooms");
    expect(dot(a, b)).toBeCloseTo(1, 5);
    expect(dot(a, c)).toBeLessThan(0.3);
  });
});
