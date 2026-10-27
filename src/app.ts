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

export interface AppDeps {
  config: GatewayConfig;
  logger?: Logger;
  cache?: ResponseCache;
  /** Defaults to an in-memory ledger. */
  access?: AccessControl;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const logger = deps.logger ?? createLogger();
  const access = deps.access ?? new AccessControl(config, new MemoryLedger());
  const pricing = new PriceBook(config.pricing);
  const pipeline = { config, logger, pricing, access, cache: deps.cache, sleep: deps.sleep, random: deps.random };
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

  const chatRoute = (format: ApiFormat) => async (c: Context) => {
    let rateHeaders: Record<string, string> = {};
    try {
      // Authenticate and rate limit before spending any effort on the body.
      const principal = access.authenticate(c.req.raw.headers);
      rateHeaders = access.rateLimit(principal);
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new GatewayError("invalid_request", "request body is not valid JSON");
      }
      const body = validateRequest(format, raw);
      return await handleChat(pipeline, {
        format,
        body,
        principal,
        headers: c.req.raw.headers,
        responseHeaders: rateHeaders,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      if (err instanceof GatewayError) return errorResponse(format, err, rateHeaders);
      if (err instanceof ClientAbortedError) return new Response(null, { status: 499 });
      logger.error("unhandled error", { err: (err as Error).stack ?? String(err) });
      return errorResponse(format, new GatewayError("upstream", "internal gateway error", { status: 500 }), rateHeaders);
    }
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
export async function createGateway(opts: Omit<AppDeps, "cache" | "access">): Promise<Gateway> {
  const logger = opts.logger ?? createLogger();
  const cache = await ResponseCache.create(opts.config, logger);
  const access = await AccessControl.create(opts.config);
  const app = createApp({ ...opts, logger, cache, access });
  return {
    app,
    close: async () => {
      await cache?.close();
      await access.close();
    },
  };
}
