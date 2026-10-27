import type { GatewayConfig, RoutingRule, Target } from "../config/schema.js";
import { GatewayError, type ApiFormat } from "../errors.js";
import type { ClientRequest } from "../translate/adapter.js";
import { estimatePromptTokens } from "./tokens.js";

export interface RouteDecision {
  /** Alias name, or `upstream/model` for direct requests. */
  route: string;
  targets: Target[];
  /** Name (or index) of the rule that matched, if any. */
  rule?: string;
  estimatedPromptTokens?: number;
}

export function routeRequest(config: GatewayConfig, format: ApiFormat, req: ClientRequest, headers: Headers): RouteDecision {
  let estimate: number | undefined;
  const tokens = () => (estimate ??= estimatePromptTokens(format, req));
  const metadata = (req as { metadata?: Record<string, unknown> }).metadata ?? {};

  for (const [i, rule] of config.routing.rules.entries()) {
    if (matches(rule, req.model, headers, metadata, tokens)) {
      return { route: rule.route, targets: config.models[rule.route]!.targets, rule: rule.name ?? `#${i}`, estimatedPromptTokens: estimate };
    }
  }

  const alias = config.models[req.model];
  if (alias) return { route: req.model, targets: alias.targets, estimatedPromptTokens: estimate };

  const slash = req.model.indexOf("/");
  if (config.routing.allowDirect && slash > 0 && config.upstreams[req.model.slice(0, slash)]) {
    return { route: req.model, targets: [{ upstream: req.model.slice(0, slash), model: req.model.slice(slash + 1) }], estimatedPromptTokens: estimate };
  }
  const known = Object.keys(config.models).join(", ");
  throw new GatewayError(
    "not_found",
    `model "${req.model}" is not a configured alias (${known || "none configured"})${config.routing.allowDirect ? ' and not of the form "<upstream>/<model>"' : ""}`,
  );
}

function matches(
  rule: RoutingRule,
  model: string,
  headers: Headers,
  metadata: Record<string, unknown>,
  tokens: () => number,
): boolean {
  const w = rule.when;
  if (w.model !== undefined && !(Array.isArray(w.model) ? w.model : [w.model]).includes(model)) return false;
  for (const [name, expected] of Object.entries(w.header ?? {})) {
    const actual = headers.get(name);
    if (actual === null || (expected !== "*" && actual !== expected)) return false;
  }
  for (const [key, expected] of Object.entries(w.metadata ?? {})) {
    const actual = metadata[key];
    if (actual === undefined || (expected !== "*" && String(actual) !== expected)) return false;
  }
  if (w.minPromptTokens !== undefined && tokens() < w.minPromptTokens) return false;
  if (w.maxPromptTokens !== undefined && tokens() > w.maxPromptTokens) return false;
  return true;
}
