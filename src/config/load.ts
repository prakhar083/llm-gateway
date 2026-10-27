import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { interpolateEnv } from "./interpolate.js";
import { ConfigSchema, type GatewayConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Parse, interpolate and validate a gateway config from YAML text. */
export function parseConfig(yamlText: string, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError(`gateway config is not valid YAML: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object") {
    throw new ConfigError("gateway config must be a YAML mapping");
  }
  let interpolated: unknown;
  try {
    interpolated = interpolateEnv(raw, env);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const result = ConfigSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(`invalid gateway config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config file ${path}: ${(err as Error).message}`);
  }
  return parseConfig(text, env);
}
