import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/** LLM calls span four orders of magnitude, from cache hits to long generations. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

export class GatewayMetrics {
  readonly registry = new Registry();

  readonly requests = new Counter({
    name: "llm_gateway_requests_total",
    help: "Chat requests handled, by client format, route, final status and cache result.",
    labelNames: ["format", "route", "status", "cache"] as const,
    registers: [this.registry],
  });

  readonly duration = new Histogram({
    name: "llm_gateway_request_duration_seconds",
    help: "End-to-end request latency; for streams, until the last byte.",
    labelNames: ["format", "route", "cache"] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly timeToFirstToken = new Histogram({
    name: "llm_gateway_time_to_first_token_seconds",
    help: "Streaming only: time from request start to the first content event sent to the client.",
    labelNames: ["route"] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly upstreamAttempts = new Counter({
    name: "llm_gateway_upstream_attempts_total",
    help: "Upstream HTTP attempts by outcome (success, retryable_error, fatal_error, skipped).",
    labelNames: ["upstream", "model", "outcome"] as const,
    registers: [this.registry],
  });

  readonly upstreamLatency = new Histogram({
    name: "llm_gateway_upstream_latency_seconds",
    help: "Per-attempt upstream latency until response headers (streaming) or body (non-streaming).",
    labelNames: ["upstream", "model"] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly tokens = new Counter({
    name: "llm_gateway_tokens_total",
    help: "Tokens reported by upstreams, by direction (input/output).",
    labelNames: ["upstream", "model", "direction"] as const,
    registers: [this.registry],
  });

  readonly cost = new Counter({
    name: "llm_gateway_cost_usd_total",
    help: "Spend in USD computed from the price book.",
    labelNames: ["key", "model"] as const,
    registers: [this.registry],
  });

  readonly unpriced = new Counter({
    name: "llm_gateway_unpriced_responses_total",
    help: "Responses from models with no configured price (counted as $0).",
    labelNames: ["model"] as const,
    registers: [this.registry],
  });

  readonly cacheLookups = new Counter({
    name: "llm_gateway_cache_lookups_total",
    help: "Cache lookups by result (hit, semantic-hit, miss, bypass).",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  readonly cacheHitRatio: Gauge;

  readonly rejections = new Counter({
    name: "llm_gateway_rejections_total",
    help: "Requests rejected by the gateway before reaching an upstream.",
    labelNames: ["reason", "key"] as const,
    registers: [this.registry],
  });

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    const lookups = this.cacheLookups;
    this.cacheHitRatio = new Gauge({
      name: "llm_gateway_cache_hit_ratio",
      help: "(hit + semantic-hit) / (hit + semantic-hit + miss) since start; bypassed requests are excluded.",
      registers: [this.registry],
      async collect() {
        const values = (await lookups.get()).values;
        const count = (r: string) => values.find((v) => v.labels.result === r)?.value ?? 0;
        const hits = count("hit") + count("semantic-hit");
        const total = hits + count("miss");
        this.set(total === 0 ? 0 : hits / total);
      },
    });
    if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry, prefix: "llm_gateway_" });
  }
}
