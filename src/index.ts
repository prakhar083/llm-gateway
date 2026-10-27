#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createGateway } from "./app.js";
import { ConfigError, loadConfigFile } from "./config/load.js";
import { createLogger, type LogLevel } from "./logger.js";

function configPath(argv: string[]): string {
  const i = argv.indexOf("--config");
  if (i !== -1 && argv[i + 1]) return argv[i + 1]!;
  return process.env.GATEWAY_CONFIG ?? "gateway.yaml";
}

async function main() {
  const logger = createLogger((process.env.LOG_LEVEL as LogLevel | undefined) ?? "info");
  const path = configPath(process.argv.slice(2));
  let config;
  try {
    config = loadConfigFile(path);
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message, { path });
      process.exit(1);
    }
    throw err;
  }

  const gateway = await createGateway({ config, logger });
  const { app } = gateway;
  const server = serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port }, (info) =>
    logger.info("llm-gateway listening", { address: info.address, port: info.port, config: path }),
  );

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => void gateway.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
