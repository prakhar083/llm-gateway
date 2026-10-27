import { context, propagation, SpanKind, SpanStatusCode, trace, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { ATTR_ERROR_TYPE, ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_HTTP_ROUTE, ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT } from "@opentelemetry/semantic-conventions";
import type { CacheLookupResult } from "../cache/cache.js";
import type { GatewayConfig, Target } from "../config/schema.js";
import type { ApiFormat } from "../errors.js";
import type { Logger } from "../logger.js";
import type { RouteDecision } from "../routing/router.js";
import type { ClientRequest, Usage } from "../translate/adapter.js";
import type { AttemptHooks, AttemptRecord } from "../upstream/executor.js";
import type { GatewayMetrics } from "./metrics.js";
import { GEN_AI, GW } from "./semconv.js";

export interface Telemetry {
  tracer: Tracer;
  metrics?: GatewayMetrics;
  logger: Logger;
  accessLog: boolean;
}

/** GenAI semconv provider names for the two upstream protocols. */
const PROVIDER: Record<ApiFormat, string> = { anthropic: "anthropic", openai: "openai" };

/**
 * One per request: owns the root span, the child spans for routing, cache
 * lookup and each upstream attempt, the Prometheus observations and the
 * access-log line. For streaming responses `finish` is called when the stream
 * ends, not when the handler returns.
 */
export class RequestObserver {
  readonly span: Span;
  readonly ctx: Context;
  /** Set by the pipeline when the response is a stream that will finish later. */
  deferred = false;

  private readonly startedAt = performance.now();
  private finished = false;
  private route = "unrouted";
  private key = "anonymous";
  private cache: string = "none";
  private target?: Target;
  private usage?: Usage;
  private cost?: number;
  private attemptSpan?: Span;
  private sawFirstToken = false;

  constructor(
    private readonly tel: Telemetry,
    private readonly config: GatewayConfig,
    readonly format: ApiFormat,
    path: string,
    incomingHeaders: Headers,
  ) {
    const parent = propagation.extract(context.active(), Object.fromEntries(incomingHeaders));
    this.span = tel.tracer.startSpan(
      `POST ${path}`,
      {
        kind: SpanKind.SERVER,
        attributes: { [ATTR_HTTP_REQUEST_METHOD]: "POST", [ATTR_HTTP_ROUTE]: path, [GEN_AI.OPERATION_NAME]: "chat", [GW.CLIENT_FORMAT]: format },
      },
      parent,
    );
    this.ctx = trace.setSpan(parent, this.span);
  }

  setPrincipal(name: string) {
    this.key = name;
    this.span.setAttribute(GW.KEY, name);
  }

  setRequest(body: ClientRequest) {
    const b = body as { max_tokens?: number; max_completion_tokens?: number; temperature?: number; top_p?: number };
    this.span.setAttributes(definedAttrs({
      [GEN_AI.REQUEST_MODEL]: body.model,
      [GEN_AI.REQUEST_STREAM]: Boolean(body.stream),
      [GEN_AI.REQUEST_MAX_TOKENS]: b.max_completion_tokens ?? b.max_tokens,
      [GEN_AI.REQUEST_TEMPERATURE]: b.temperature,
      [GEN_AI.REQUEST_TOP_P]: b.top_p,
    }));
  }

  routed(d: RouteDecision) {
    this.route = d.route;
    const span = this.tel.tracer.startSpan("llm_gateway.route", { attributes: definedAttrs({
      [GW.ROUTE]: d.route,
      [GW.RULE]: d.rule,
      [GW.TARGETS]: d.targets.map((t) => `${t.upstream}/${t.model}`),
      [GW.ESTIMATED_PROMPT_TOKENS]: d.estimatedPromptTokens,
    }) }, this.ctx);
    span.end();
    this.span.setAttribute(GW.ROUTE, d.route);
  }

  async cacheLookup(fn: () => Promise<CacheLookupResult>): Promise<CacheLookupResult> {
    const span = this.tel.tracer.startSpan("llm_gateway.cache.lookup", {}, this.ctx);
    try {
      const result = await fn();
      this.cache = result.status;
      span.setAttributes(definedAttrs({ [GW.CACHE_STATUS]: result.status, [GW.CACHE_SIMILARITY]: result.similarity }));
      this.span.setAttribute(GW.CACHE_STATUS, result.status);
      this.tel.metrics?.cacheLookups.inc({ result: result.status });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  }

  reject(reason: string) {
    this.tel.metrics?.rejections.inc({ reason, key: this.key });
  }

  /** Spans and metrics for each upstream attempt; the successful attempt stays open until usage is known. */
  attemptHooks(body: ClientRequest): AttemptHooks {
    return {
      start: (target, attempt) => {
        const upstream = this.config.upstreams[target.upstream]!;
        const url = safeUrl(upstream.baseUrl);
        const span = this.tel.tracer.startSpan(
          `chat ${target.model}`,
          {
            kind: SpanKind.CLIENT,
            attributes: definedAttrs({
              [GEN_AI.OPERATION_NAME]: "chat",
              [GEN_AI.PROVIDER_NAME]: PROVIDER[upstream.type],
              [GEN_AI.SYSTEM]: PROVIDER[upstream.type],
              [GEN_AI.REQUEST_MODEL]: target.model,
              [GEN_AI.REQUEST_STREAM]: Boolean(body.stream),
              [GW.UPSTREAM]: target.upstream,
              [GW.ATTEMPT]: attempt,
              [ATTR_SERVER_ADDRESS]: url?.hostname,
              [ATTR_SERVER_PORT]: url ? Number(url.port || (url.protocol === "https:" ? 443 : 80)) : undefined,
            }),
          },
          this.ctx,
        );
        const headers: Record<string, string> = {};
        propagation.inject(trace.setSpan(this.ctx, span), headers);
        return {
          headers,
          end: (record: AttemptRecord) => this.endAttempt(span, record),
        };
      },
    };
  }

  private endAttempt(span: Span, record: AttemptRecord) {
    const labels = { upstream: record.target.upstream, model: record.target.model };
    this.tel.metrics?.upstreamAttempts.inc({ ...labels, outcome: record.outcome });
    this.tel.metrics?.upstreamLatency.observe(labels, record.durationMs / 1000);
    span.setAttribute(GW.ATTEMPT_OUTCOME, record.outcome);
    if (record.status !== undefined) span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, record.status);
    if (record.outcome === "success") {
      this.target = record.target;
      this.attemptSpan = span;
      const provider = PROVIDER[this.config.upstreams[record.target.upstream]!.type];
      this.span.setAttributes({ [GW.UPSTREAM]: record.target.upstream, [GEN_AI.PROVIDER_NAME]: provider, [GEN_AI.SYSTEM]: provider });
      return;
    }
    span.setAttribute(ATTR_ERROR_TYPE, record.errorType ?? (record.status ? String(record.status) : "_OTHER"));
    span.setStatus({ code: SpanStatusCode.ERROR, message: record.error });
    span.end();
  }

  /** Called once usage is known (immediately for JSON, at end of stream for SSE). */
  recordResponse(info: { usage: Usage; cost?: number; responseModel?: string; responseId?: string; finishReason?: string | null }) {
    this.usage = info.usage;
    this.cost = info.cost;
    const attrs = definedAttrs({
      [GEN_AI.RESPONSE_MODEL]: info.responseModel,
      [GEN_AI.RESPONSE_ID]: info.responseId,
      [GEN_AI.RESPONSE_FINISH_REASONS]: info.finishReason ? [info.finishReason] : undefined,
      [GEN_AI.USAGE_INPUT_TOKENS]: info.usage.inputTokens,
      [GEN_AI.USAGE_OUTPUT_TOKENS]: info.usage.outputTokens,
      [GEN_AI.USAGE_CACHE_READ_INPUT_TOKENS]: info.usage.cachedInputTokens || undefined,
    });
    this.span.setAttributes(attrs);
    if (info.cost !== undefined) this.span.setAttribute(GW.COST_USD, info.cost);
    if (this.attemptSpan) {
      this.attemptSpan.setAttributes(attrs);
      this.attemptSpan.end();
      this.attemptSpan = undefined;
    }
    const m = this.tel.metrics;
    if (m && this.target) {
      const labels = { upstream: this.target.upstream, model: this.target.model };
      m.tokens.inc({ ...labels, direction: "input" }, info.usage.inputTokens);
      m.tokens.inc({ ...labels, direction: "output" }, info.usage.outputTokens);
      if (info.cost === undefined) m.unpriced.inc({ model: this.target.model });
      else m.cost.inc({ key: this.key, model: this.target.model }, info.cost);
    }
  }

  firstToken() {
    if (this.sawFirstToken) return;
    this.sawFirstToken = true;
    this.tel.metrics?.timeToFirstToken.observe({ route: this.route }, (performance.now() - this.startedAt) / 1000);
  }

  /** Idempotent. `status` is the HTTP status the client saw (499 = client went away). */
  finish(status: number, error?: string) {
    if (this.finished) return;
    this.finished = true;
    const seconds = (performance.now() - this.startedAt) / 1000;
    this.tel.metrics?.requests.inc({ format: this.format, route: this.route, status: String(status), cache: this.cache });
    this.tel.metrics?.duration.observe({ format: this.format, route: this.route, cache: this.cache }, seconds);

    if (this.attemptSpan) {
      // stream ended without a usable final response
      this.attemptSpan.setStatus({ code: SpanStatusCode.ERROR, message: error ?? "stream did not complete" });
      this.attemptSpan.end();
    }
    this.span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
    if (status >= 500 || error) {
      this.span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      if (error) this.span.setAttribute(ATTR_ERROR_TYPE, error);
    }
    this.span.end();

    if (this.tel.accessLog) {
      this.tel.logger.info("request", {
        format: this.format,
        route: this.route,
        status,
        durationMs: Math.round(seconds * 1000),
        key: this.key,
        cache: this.cache,
        upstream: this.target?.upstream,
        model: this.target?.model,
        inputTokens: this.usage?.inputTokens,
        outputTokens: this.usage?.outputTokens,
        costUsd: this.cost,
        error,
        traceId: this.span.spanContext().traceId,
      });
    }
  }
}

function definedAttrs(o: Record<string, string | number | boolean | string[] | undefined>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean | string[]>;
}

function safeUrl(u: string): URL | undefined {
  try {
    return new URL(u);
  } catch {
    return undefined;
  }
}
