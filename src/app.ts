import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AccessControl } from "./auth/access.js";
import { MemoryLedger } from "./auth/ledger.js";
import { ResponseCache } from "./cache/cache.js";
import type { GatewayConfig } from "./config/schema.js";
import { GatewayError, type ApiFormat } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";
import { errorResponse, handleChat, validateRequest } from "./pipeline.js";
import { PriceBook } from "./pricing.js";
import { ClientAbortedError } from "./upstream/client.js";
import { trace, type Tracer } from "@opentelemetry/api";
import { GatewayMetrics } from "./telemetry/metrics.js";
import { RequestObserver } from "./telemetry/observer.js";
import { initTracing } from "./telemetry/tracing.js";

export interface AppDeps {
  config: GatewayConfig;
  logger?: Logger;
  cache?: ResponseCache;
  /** Defaults to an in-memory ledger. */
  access?: AccessControl;
  /** Defaults to the global (no-op unless registered) tracer. */
  tracer?: Tracer;
  metrics?: GatewayMetrics;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const logger = deps.logger ?? createLogger();
  const access = deps.access ?? new AccessControl(config, new MemoryLedger());
  const pricing = new PriceBook(config.pricing);
  const pipeline = { config, logger, pricing, access, cache: deps.cache, sleep: deps.sleep, random: deps.random };
  const metrics = config.telemetry.metrics.enabled ? (deps.metrics ?? new GatewayMetrics({ defaultMetrics: false })) : undefined;
  const telemetry = { tracer: deps.tracer ?? trace.getTracer("llm-gateway"), metrics, logger, accessLog: config.telemetry.accessLog };
  const startedAt = Date.now();
  const app = new Hono();

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      upstreams: Object.keys(config.upstreams),
      models: Object.keys(config.models),
    }),
  );

  if (metrics) {
    app.get(config.telemetry.metrics.path, async (c) => {
      c.header("content-type", metrics.registry.contentType);
      return c.body(await metrics.registry.metrics());
    });
  }

  const chatRoute = (format: ApiFormat) => async (c: Context) => {
    const obs = new RequestObserver(telemetry, config, format, c.req.path, c.req.raw.headers);
    let rateHeaders: Record<string, string> = {};
    let response: Response;
    try {
      // Authenticate and rate limit before spending any effort on the body.
      let principal;
      try {
        principal = access.authenticate(c.req.raw.headers);
      } catch (err) {
        obs.reject("authentication");
        throw err;
      }
      obs.setPrincipal(principal.name);
      try {
        rateHeaders = access.rateLimit(principal);
      } catch (err) {
        obs.reject("rate_limit");
        throw err;
      }
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new GatewayError("invalid_request", "request body is not valid JSON");
      }
      const body = validateRequest(format, raw);
      obs.setRequest(body);
      response = await handleChat(pipeline, {
        format,
        body,
        principal,
        obs,
        headers: c.req.raw.headers,
        responseHeaders: rateHeaders,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      if (err instanceof GatewayError) {
        obs.finish(err.status, err.kind);
        return errorResponse(format, err, rateHeaders);
      }
      if (err instanceof ClientAbortedError) {
        obs.finish(499, "client_disconnected");
        return new Response(null, { status: 499 });
      }
      logger.error("unhandled error", { err: (err as Error).stack ?? String(err) });
      obs.finish(500, "internal_error");
      return errorResponse(format, new GatewayError("upstream", "internal gateway error", { status: 500 }), rateHeaders);
    }
    if (!obs.deferred) obs.finish(response.status, response.ok ? undefined : `upstream_${response.status}`);
    return response;
  };

  const limit = bodyLimit({
    maxSize: config.server.bodyLimitBytes,
    onError: (c) => {
      const format: ApiFormat = c.req.path.endsWith("/messages") ? "anthropic" : "openai";
      return errorResponse(format, new GatewayError("invalid_request", "request body too large", { status: 413 }));
    },
  });
  app.post("/v1/chat/completions", limit, chatRoute("openai"));
  app.post("/v1/messages", limit, chatRoute("anthropic"));

  app.notFound((c) => c.json({ error: { message: `no route for ${c.req.method} ${c.req.path}`, type: "not_found" } }, 404));
  return app;
}

export interface Gateway {
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** Build the app together with the stateful components the config asks for. */
export async function createGateway(opts: Omit<AppDeps, "cache" | "access" | "tracer" | "metrics">): Promise<Gateway> {
  const logger = opts.logger ?? createLogger();
  const tracing = initTracing(opts.config.telemetry);
  const cache = await ResponseCache.create(opts.config, logger);
  const access = await AccessControl.create(opts.config);
  const metrics = new GatewayMetrics({ defaultMetrics: true });
  const app = createApp({ ...opts, logger, cache, access, tracer: tracing.tracer, metrics });
  return {
    app,
    close: async () => {
      await cache?.close();
      await access.close();
      await tracing.shutdown();
    },
  };
}
