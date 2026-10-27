import type { Price } from "./config/schema.js";
import type { Usage } from "./translate/adapter.js";

/**
 * Built-in prices in USD per million tokens, for the Claude models whose list
 * prices this project could verify. Everything else must be priced in
 * gateway.yaml; unpriced models are counted as $0 and flagged in logs and
 * metrics so budgets are never silently wrong without a trace.
 */
export const DEFAULT_PRICING: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longContext: { thresholdTokens: 100_000, input: 0.5, output: 2.5 } },
};

export class PriceBook {
  private readonly exact = new Map<string, Price>();
  private readonly prefixes: Array<[string, Price]> = [];

  constructor(overrides: Record<string, Price> = {}) {
    for (const [model, price] of Object.entries({ ...DEFAULT_PRICING, ...overrides })) {
      if (model.endsWith("*")) this.prefixes.push([model.slice(0, -1), price]);
      else this.exact.set(model, price);
    }
    // longest prefix wins
    this.prefixes.sort(([a], [b]) => b.length - a.length);
  }

  lookup(model: string): Price | undefined {
    return this.exact.get(model) ?? this.prefixes.find(([p]) => model.startsWith(p))?.[1];
  }

  /** Cost in USD, or undefined when the model has no price. */
  cost(model: string, usage: Usage): number | undefined {
    const price = this.lookup(model);
    if (!price) return undefined;
    const long = price.longContext && usage.inputTokens > price.longContext.thresholdTokens ? price.longContext : undefined;
    const inputRate = long?.input ?? price.input;
    const outputRate = long?.output ?? price.output;
    const cachedRate = price.cachedInput ?? inputRate;
    const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
    const usd = ((usage.inputTokens - cached) * inputRate + cached * cachedRate + usage.outputTokens * outputRate) / 1_000_000;
    return Math.round(usd * 1e10) / 1e10;
  }
}
