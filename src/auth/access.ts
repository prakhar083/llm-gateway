import { createHash } from "node:crypto";
import type { GatewayConfig, VirtualKeyConfig } from "../config/schema.js";
import { GatewayError } from "../errors.js";
import { currentPeriod, MemoryLedger, SqliteLedger, type SpendLedger } from "./ledger.js";
import { TokenBucket } from "./rate-limit.js";

export interface Principal {
  /** Virtual key name, or "anonymous" when auth is not required. */
  name: string;
  key?: VirtualKeyConfig;
}

const ANONYMOUS: Principal = { name: "anonymous" };

const digest = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Virtual-key authentication, per-key rate limits and monthly USD budgets.
 * Presented secrets are compared by SHA-256 digest via a map lookup, so the
 * comparison time does not depend on how many leading characters match.
 */
export class AccessControl {
  private readonly byDigest = new Map<string, VirtualKeyConfig>();
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly required: boolean;

  constructor(
    config: GatewayConfig,
    private readonly ledger: SpendLedger,
    private readonly clock: () => Date = () => new Date(),
  ) {
    for (const k of config.auth.keys) {
      this.byDigest.set(digest(k.key), k);
      if (k.requestsPerMinute) this.buckets.set(k.name, new TokenBucket(k.requestsPerMinute, k.burst ?? Math.max(1, Math.ceil(k.requestsPerMinute))));
    }
    this.required = config.auth.required ?? config.auth.keys.length > 0;
  }

  static async create(config: GatewayConfig): Promise<AccessControl> {
    const store = config.budgets.store;
    const ledger = store.type === "sqlite" ? await SqliteLedger.open(store.path) : new MemoryLedger();
    return new AccessControl(config, ledger);
  }

  authenticate(headers: Headers): Principal {
    const presented = bearer(headers.get("authorization")) ?? headers.get("x-api-key") ?? undefined;
    if (presented) {
      const key = this.byDigest.get(digest(presented));
      if (key) return { name: key.name, key };
      if (this.required) throw new GatewayError("authentication", "invalid API key");
    }
    if (this.required) throw new GatewayError("authentication", "missing API key: send `Authorization: Bearer <key>` or `x-api-key`");
    return ANONYMOUS;
  }

  /** Consumes one request token; returns rate-limit headers for the response. */
  rateLimit(p: Principal): Record<string, string> {
    const bucket = this.buckets.get(p.name);
    if (!bucket) return {};
    const r = bucket.take(this.clock().getTime());
    const headers = {
      "x-ratelimit-limit-requests": String(bucket.ratePerMinute),
      "x-ratelimit-remaining-requests": String(r.remaining),
    };
    if (!r.ok) {
      throw new GatewayError("rate_limit", `rate limit of ${bucket.ratePerMinute} requests/minute exceeded for key "${p.name}"`, {
        headers: { ...headers, "retry-after": String(Math.ceil(r.retryAfterMs / 1000)) },
      });
    }
    return headers;
  }

  authorizeRoute(p: Principal, route: string): void {
    const allowed = p.key?.models;
    if (allowed && !allowed.includes(route)) {
      throw new GatewayError("permission", `key "${p.name}" is not allowed to use model "${route}"`);
    }
  }

  /** Remaining monthly budget in USD (undefined = unlimited). Throws once the budget is spent. */
  async checkBudget(p: Principal): Promise<number | undefined> {
    const budget = p.key?.budgetUsdMonthly;
    if (budget === undefined) return undefined;
    const spent = await this.ledger.get(p.name, currentPeriod(this.clock()));
    if (spent >= budget) {
      throw new GatewayError("budget_exceeded", `monthly budget of $${budget.toFixed(2)} for key "${p.name}" is exhausted ($${spent.toFixed(4)} spent)`);
    }
    return budget - spent;
  }

  /** Record spend; returns the remaining budget after the charge. */
  async charge(p: Principal, usd: number): Promise<number | undefined> {
    const total = usd > 0 ? await this.ledger.add(p.name, currentPeriod(this.clock()), usd) : await this.ledger.get(p.name, currentPeriod(this.clock()));
    const budget = p.key?.budgetUsdMonthly;
    return budget === undefined ? undefined : Math.max(0, budget - total);
  }

  spent(name: string): Promise<number> {
    return this.ledger.get(name, currentPeriod(this.clock()));
  }

  close(): Promise<void> {
    return this.ledger.close();
  }
}

function bearer(value: string | null): string | undefined {
  const m = value?.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim();
}
