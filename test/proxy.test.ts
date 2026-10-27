import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { silentLogger } from "../src/logger.js";
import { startMockUpstream, type MockUpstream } from "../src/testing/mock-upstream.js";
import { configFrom, json, listen, post, readSSE, sseJson } from "./helpers.js";

let mock: MockUpstream;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  mock = await startMockUpstream();
  const config = configFrom(
    `
upstreams:
  oai: { type: openai, baseUrl: "{{openai}}", apiKey: sk-upstream-oai }
  ant: { type: anthropic, baseUrl: "{{anthropic}}", apiKey: sk-upstream-ant, defaultMaxTokens: 777 }
models:
  claude: { targets: [ant/claude-sonnet-5-5] }
  llama: { targets: [oai/llama-3.3-70b] }
`,
    { openai: mock.url, anthropic: mock.url },
  );
  app = createApp({ config, logger: silentLogger });
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.requests.length = 0;
  mock.setHandler(undefined);
});

const tools = [{ type: "function", function: { name: "search", parameters: { type: "object", properties: { query: { type: "string" } } } } }];

describe("OpenAI-compatible endpoint", () => {
  it("routes an alias to Anthropic and translates request and response", async () => {
    const res = await post(app, "/v1/chat/completions", { model: "claude", messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream")).toBe("ant");
    const body = await json(res);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("echo: hello");
    expect(body.model).toBe("claude-sonnet-5-5");

    const upstreamReq = mock.requests[0]!;
    expect(upstreamReq.path).toBe("/v1/messages");
    expect(upstreamReq.headers["x-api-key"]).toBe("sk-upstream-ant");
    expect(upstreamReq.headers["anthropic-version"]).toBe("2023-06-01");
    expect(upstreamReq.body).toMatchObject({ model: "claude-sonnet-5-5", system: "sys", max_tokens: 777 });
  });

  it("streams Anthropic tool calls as OpenAI tool_call deltas", async () => {
    const res = await post(app, "/v1/chat/completions", { model: "claude", stream: true, tools, messages: [{ role: "user", content: "find cats" }] });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSSE(res);
    expect(events.at(-1)!.data).toBe("[DONE]");
    const chunks = sseJson(events);
    const args = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).map((t: any) => t.function.arguments).join("");
    expect(JSON.parse(args)).toEqual({ query: "find cats" });
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe("tool_calls");
    expect(chunks.some((c) => c.usage)).toBe(false); // client did not ask for usage
  });

  it("passes OpenAI-to-OpenAI traffic through and only exposes usage when requested", async () => {
    const res = await post(app, "/v1/chat/completions", { model: "oai/gpt-direct", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "a b c" }], metadata: { team: "x" } });
    const chunks = sseJson(await readSSE(res));
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? "").join("")).toBe("echo: a b c");
    expect(chunks.at(-1).usage.total_tokens).toBeGreaterThan(0);
    expect(mock.requests[0]!.body.model).toBe("gpt-direct");
    expect(mock.requests[0]!.body.metadata).toBeUndefined();
    expect(mock.requests[0]!.headers.authorization).toBe("Bearer sk-upstream-oai");
  });

  it("re-encodes upstream errors in the client's format", async () => {
    mock.setHandler(() => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } } }));
    const res = await post(app, "/v1/chat/completions", { model: "claude", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: { message: "prompt is too long", type: "invalid_request_error", param: null, code: null } });
  });

  it("returns 404 in OpenAI format for unknown models and 400 for invalid bodies", async () => {
    const res = await post(app, "/v1/chat/completions", { model: "nope", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("model_not_found");
    const bad = await app.request("/v1/chat/completions", { method: "POST", body: "{not json" });
    expect(bad.status).toBe(400);
  });
});

describe("Anthropic-compatible endpoint", () => {
  it("routes to an OpenAI-compatible upstream and returns an Anthropic message", async () => {
    const res = await post(app, "/v1/messages", { model: "llama", max_tokens: 50, system: "be nice", messages: [{ role: "user", content: "hey" }] });
    const body = await json(res);
    expect(body).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "echo: hey" }], stop_reason: "end_turn" });
    expect(mock.requests[0]!.body.messages[0]).toEqual({ role: "system", content: "be nice" });
  });

  it("streams OpenAI tool calls as Anthropic tool_use blocks", async () => {
    const res = await post(app, "/v1/messages", {
      model: "llama",
      max_tokens: 50,
      stream: true,
      tools: [{ name: "search", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "dogs" }],
    });
    const events = sseJson(await readSSE(res));
    expect(events[0].type).toBe("message_start");
    expect(events.at(-1).type).toBe("message_stop");
    const start = events.find((e) => e.type === "content_block_start" && e.content_block.type === "tool_use");
    expect(start.content_block).toMatchObject({ id: "call_mock_1", name: "search" });
    const json = events.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ query: "dogs" });
    expect(events.find((e) => e.type === "message_delta").usage.output_tokens).toBeGreaterThan(0);
  });

  it("passes anthropic-version and anthropic-beta through on same-format traffic", async () => {
    await post(app, "/v1/messages", { model: "claude", max_tokens: 5, messages: [{ role: "user", content: "x" }], metadata: { user_id: "u", tier: "gold" } }, { "anthropic-version": "2026-10-21", "anthropic-beta": "some-beta" });
    const h = mock.requests[0]!.headers;
    expect(h["anthropic-version"]).toBe("2026-10-21");
    expect(h["anthropic-beta"]).toBe("some-beta");
    expect(mock.requests[0]!.body.metadata).toEqual({ user_id: "u" });
  });

  it("requires max_tokens and answers errors in Anthropic format", async () => {
    const res = await post(app, "/v1/messages", { model: "claude", messages: [{ role: "user", content: "x" }] });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ type: "error", error: { type: "invalid_request_error", message: "`max_tokens` is required" } });
  });
});

describe("official SDKs against the gateway", () => {
  let gw: { url: string; close(): Promise<void> };
  beforeAll(async () => {
    gw = await listen(app);
  });
  afterAll(() => gw.close());

  it("OpenAI SDK: non-streaming and streaming against an Anthropic-backed alias", async () => {
    const client = new OpenAI({ baseURL: `${gw.url}/v1`, apiKey: "unused" });
    const res = await client.chat.completions.create({ model: "claude", messages: [{ role: "user", content: "ping" }] });
    expect(res.choices[0]!.message.content).toBe("echo: ping");

    const stream = await client.chat.completions.create({ model: "claude", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "stream me" }] });
    let text = "";
    let usage: unknown;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      if (chunk.usage) usage = chunk.usage;
    }
    expect(text).toBe("echo: stream me");
    expect(usage).toMatchObject({ completion_tokens: expect.any(Number) });
  });

  it("Anthropic SDK: streaming tool use against an OpenAI-backed alias", async () => {
    const client = new Anthropic({ baseURL: gw.url, apiKey: "unused" });
    const final = await client.messages
      .stream({ model: "llama", max_tokens: 64, tools: [{ name: "search", input_schema: { type: "object" } }], messages: [{ role: "user", content: "otters" }] })
      .finalMessage();
    expect(final.stop_reason).toBe("tool_use");
    const toolUse = final.content.find((b) => b.type === "tool_use");
    expect(toolUse).toMatchObject({ name: "search", input: { query: "otters" } });
  });
});
