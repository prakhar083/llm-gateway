import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GatewayConfig } from "./config/schema.js";
import { GatewayError, type ApiFormat } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";
import { errorResponse, handleChat, validateRequest } from "./pipeline.js";
import { ClientAbortedError } from "./upstream/client.js";
import { ResponseCache } from "./cache/cache.js";

export interface AppDeps {
  config: GatewayConfig;
  logger?: Logger;
  cache?: ResponseCache;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const logger = deps.logger ?? createLogger();
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
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return errorResponse(format, new GatewayError("invalid_request", "request body is not valid JSON"));
    }
    try {
      const body = validateRequest(format, raw);
      return await handleChat({ config, logger, cache: deps.cache, sleep: deps.sleep, random: deps.random }, { format, body, headers: c.req.raw.headers, signal: c.req.raw.signal });
    } catch (err) {
      if (err instanceof GatewayError) return errorResponse(format, err);
      if (err instanceof ClientAbortedError) return new Response(null, { status: 499 });
      logger.error("unhandled error", { err: (err as Error).stack ?? String(err) });
      return errorResponse(format, new GatewayError("upstream", "internal gateway error", { status: 500 }));
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
export async function createGateway(opts: Omit<AppDeps, "cache">): Promise<Gateway> {
  const logger = opts.logger ?? createLogger();
  const cache = await ResponseCache.create(opts.config, logger);
  const app = createApp({ ...opts, logger, cache });
  return {
    app,
    close: async () => {
      await cache?.close();
    },
  };
}
