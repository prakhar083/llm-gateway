import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ResponseCache } from "../src/cache/cache.js";
import { MemoryCacheStore } from "../src/cache/memory-store.js";
import { silentLogger } from "../src/logger.js";
import { GatewayMetrics } from "../src/telemetry/metrics.js";
import { startMockUpstream, type MockUpstream } from "../src/testing/mock-upstream.js";
import { configFrom, json, post, readSSE } from "./helpers.js";

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
const tracer = provider.getTracer("test");

let primary: MockUpstream;
let backup: MockUpstream;
let metrics: GatewayMetrics;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  primary = await startMockUpstream();
  backup = await startMockUpstream();
});
afterAll(async () => {
  await primary.close();
  await backup.close();
  await provider.shutdown();
});
beforeEach(() => {
  exporter.reset();
  primary.requests.length = 0;
  backup.requests.length = 0;
  primary.setHandler(undefined);
  const config = configFrom(
    `
upstreams:
  primary: { type: openai, baseUrl: "{{openai}}" }
  backup: { type: anthropic, baseUrl: "{{anthropic}}" }
models:
  chain: { targets: [primary/gpt-test, backup/claude-haiku-5-5] }
retry: { maxAttempts: 2, baseDelayMs: 0 }
cache: { enabled: true }
`,
    { openai: primary.url, anthropic: backup.url },
  );
  metrics = new GatewayMetrics({ defaultMetrics: false });
  const cache = new ResponseCache(config.cache, new MemoryCacheStore(), undefined, silentLogger);
  app = createApp({ config, logger: silentLogger, tracer, metrics, cache, sleep: async () => {} });
});

const byName = (spans: ReadableSpan[], name: string) => spans.filter((s) => s.name === name);
const parentId = (s: ReadableSpan) => s.parentSpanContext?.spanId;
/** Spans end asynchronously at the end of a stream; wait until the root span is exported. */
async function spansWhenDone(): Promise<ReadableSpan[]> {
  for (let i = 0; i < 50; i++) {
    const spans = exporter.getFinishedSpans();
    if (spans.some((s) => s.kind === SpanKind.SERVER)) return spans;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("root span never ended");
}

describe("tracing", () => {
  it("emits a GenAI-convention span tree for routing, cache lookup and each upstream attempt", async () => {
    primary.setHandler(() => ({ status: 503, json: { error: { message: "busy" } } }));
    const res = await post(app, "/v1/chat/completions", { model: "chain", temperature: 0, max_tokens: 64, messages: [{ role: "user", content: "trace me" }] });
    expect(res.status).toBe(200);
    const body = await json(res);
    const spans = await spansWhenDone();

    const [root] = spans.filter((s) => s.kind === SpanKind.SERVER);
    expect(root!.name).toBe("POST /v1/chat/completions");
    expect(root!.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "chain",
      "gen_ai.request.max_tokens": 64,
      "gen_ai.request.temperature": 0,
      "gen_ai.provider.name": "anthropic",
      "gen_ai.system": "anthropic",
      "gen_ai.response.model": "claude-haiku-5-5",
      "gen_ai.usage.input_tokens": body.usage.prompt_tokens,
      "gen_ai.usage.output_tokens": body.usage.completion_tokens,
      "http.response.status_code": 200,
      "llm_gateway.route": "chain",
      "llm_gateway.cache.status": "miss",
      "llm_gateway.upstream": "backup",
    });
    expect(root!.attributes["llm_gateway.cost_usd"]).toBeGreaterThan(0);

    const children = spans.filter((s) => s !== root);
    expect(children.every((s) => s.spanContext().traceId === root!.spanContext().traceId && parentId(s) === root!.spanContext().spanId)).toBe(true);
    expect(byName(spans, "llm_gateway.route")[0]!.attributes).toMatchObject({
      "llm_gateway.routing.targets": ["primary/gpt-test", "backup/claude-haiku-5-5"],
    });
    expect(byName(spans, "llm_gateway.cache.lookup")[0]!.attributes["llm_gateway.cache.status"]).toBe("miss");

    const failed = byName(spans, "chat gpt-test");
    expect(failed).toHaveLength(2);
    for (const s of failed) {
      expect(s.kind).toBe(SpanKind.CLIENT);
      expect(s.status.code).toBe(SpanStatusCode.ERROR);
      expect(s.attributes).toMatchObject({ "error.type": "503", "http.response.status_code": 503, "gen_ai.provider.name": "openai", "server.address": "127.0.0.1" });
    }
    const [ok] = byName(spans, "chat claude-haiku-5-5");
    expect(ok!.attributes).toMatchObject({
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-haiku-5-5",
      "gen_ai.response.model": "claude-haiku-5-5",
      "gen_ai.response.finish_reasons": ["stop"],
      "gen_ai.usage.input_tokens": body.usage.prompt_tokens,
      "llm_gateway.attempt": 1,
      "llm_gateway.attempt.outcome": "success",
    });
  });

  it("continues an incoming trace and propagates W3C trace context to upstreams", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    await post(app, "/v1/chat/completions", { model: "chain", messages: [{ role: "user", content: "x" }] }, { traceparent: `00-${traceId}-00f067aa0ba902b7-01` });
    const spans = await spansWhenDone();
    expect(spans.every((s) => s.spanContext().traceId === traceId)).toBe(true);
    const sent = primary.requests[0]!.headers.traceparent as string;
    const attempt = byName(spans, "chat gpt-test")[0]!;
    expect(sent).toBe(`00-${traceId}-${attempt.spanContext().spanId}-01`);
  });

  it("keeps the root and attempt spans open until a stream finishes, then records usage", async () => {
    const res = await post(app, "/v1/messages", { model: "chain", max_tokens: 20, stream: true, messages: [{ role: "user", content: "stream" }] });
    expect(exporter.getFinishedSpans().some((s) => s.kind === SpanKind.SERVER)).toBe(false);
    const events = await readSSE(res);
    const spans = await spansWhenDone();
    const usage = JSON.parse(events.find((e) => e.event === "message_delta")!.data).usage;
    const attempt = byName(spans, "chat gpt-test")[0]!;
    expect(attempt.attributes["gen_ai.usage.output_tokens"]).toBe(usage.output_tokens);
    expect(attempt.attributes["gen_ai.request.stream"]).toBe(true);
  });
});

describe("metrics", () => {
  const scrape = async () => (await app.request("/metrics")).text();

  it("exposes request, latency, token, cost, attempt and cache metrics in Prometheus format", async () => {
    primary.setHandler(() => ({ status: 503, json: {} }));
    const req = { model: "chain", temperature: 0, messages: [{ role: "user", content: "metrics" }] };
    await json(await post(app, "/v1/chat/completions", req));
    await new Promise((r) => setTimeout(r, 5));
    await json(await post(app, "/v1/chat/completions", req));
    await post(app, "/v1/chat/completions", { model: "nope", messages: [{ role: "user", content: "x" }] });

    const res = await app.request("/metrics");
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toMatch(/llm_gateway_requests_total\{format="openai",route="chain",status="200",cache="miss"\} 1/);
    expect(text).toMatch(/llm_gateway_requests_total\{format="openai",route="chain",status="200",cache="hit"\} 1/);
    expect(text).toMatch(/llm_gateway_requests_total\{format="openai",route="unrouted",status="404",cache="none"\} 1/);
    expect(text).toMatch(/llm_gateway_upstream_attempts_total\{upstream="primary",model="gpt-test",outcome="retryable_error"\} 2/);
    expect(text).toMatch(/llm_gateway_upstream_attempts_total\{upstream="backup",model="claude-haiku-5-5",outcome="success"\} 1/);
    expect(text).toMatch(/llm_gateway_tokens_total\{upstream="backup",model="claude-haiku-5-5",direction="output"\} \d+/);
    expect(text).toMatch(/llm_gateway_cost_usd_total\{key="anonymous",model="claude-haiku-5-5"\} [\d.e-]+/);
    expect(text).toMatch(/llm_gateway_request_duration_seconds_bucket\{le="0.5",format="openai",route="chain",cache="hit"\} 1/);
    expect(text).toMatch(/llm_gateway_cache_hit_ratio 0.5/);
  });

  it("records time to first token for streams and 499 for clients that disconnect", async () => {
    await readSSE(await post(app, "/v1/chat/completions", { model: "chain", stream: true, messages: [{ role: "user", content: "a b c" }] }));
    const res = await post(app, "/v1/chat/completions", { model: "chain", stream: true, messages: [{ role: "user", content: "bye" }] });
    await res.body!.cancel();
    const text = await scrape();
    expect(text).toMatch(/llm_gateway_time_to_first_token_seconds_count\{route="chain"\} [12]/);
    expect(text).toMatch(/llm_gateway_requests_total\{format="openai",route="chain",status="499",cache="bypass"\} 1/);
  });
});

describe("health", () => {
  it("reports status and configured upstreams", async () => {
    const res = await app.request("/healthz");
    expect(await json(res)).toMatchObject({ status: "ok", upstreams: ["primary", "backup"], models: ["chain"] });
  });
});
