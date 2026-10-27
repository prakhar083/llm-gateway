import { Hono } from "hono";
import type { GatewayConfig } from "./config/schema.js";
import { createLogger, type Logger } from "./logger.js";

export interface AppDeps {
  config: GatewayConfig;
  logger?: Logger;
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
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

  return app;
}

export { createLogger };
