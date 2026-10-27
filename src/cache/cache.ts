import type { CacheConfig, GatewayConfig } from "../config/schema.js";
import type { ApiFormat } from "../errors.js";
import type { ANTContentBlock, ANTRequest } from "../formats/anthropic.js";
import { oaiContentText, type OAIChatRequest } from "../formats/openai.js";
import type { Logger } from "../logger.js";
import type { ClientRequest, ClientResponse } from "../translate/adapter.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { sha256, stableStringify } from "./hash.js";
import { MemoryCacheStore } from "./memory-store.js";
import { SqliteCacheStore } from "./sqlite-store.js";
import type { CacheStore } from "./store.js";

export type CacheStatus = "hit" | "semantic-hit" | "miss" | "bypass";

/** Per-request cache state, created before routing to the upstream and reused to store the result. */
export interface CachePlan {
  /** Whether to read from the cache. */
  lookup: boolean;
  /** Whether to write the upstream response to the cache. */
  store: boolean;
  /** Why the request is not cached at all (for logs / span attributes). */
  bypassReason?: string;
  exactKey: string;
  /** Semantic tier: present only when the request is eligible. */
  semantic?: { scope: string; text: string; vector?: Float32Array };
}

export interface CacheLookupResult {
  status: CacheStatus;
  response?: ClientResponse;
  similarity?: number;
  ageSeconds?: number;
}

/** Fields that do not influence the generated output. */
const IGNORED_FIELDS = ["stream", "stream_options", "metadata", "user", "service_tier", "store"];

export class ResponseCache {
  constructor(
    private readonly cfg: CacheConfig,
    private readonly store: CacheStore,
    private readonly embedder: Embedder | undefined,
    private readonly logger: Logger,
  ) {}

  static async create(config: GatewayConfig, logger: Logger): Promise<ResponseCache | undefined> {
    const cfg = config.cache;
    if (!cfg.enabled) return undefined;
    const store = cfg.store.type === "sqlite" ? await SqliteCacheStore.open(cfg.store.path) : new MemoryCacheStore(cfg.store.maxEntries);
    const embedder = cfg.semantic.enabled ? createEmbedder(cfg.semantic.embedder, config) : undefined;
    return new ResponseCache(cfg, store, embedder, logger);
  }

  /**
   * Decide how this request interacts with the cache.
   * `partition` is the virtual key name (or "" when keys are shared / auth is off).
   */
  plan(format: ApiFormat, req: ClientRequest, route: string, partition: string, headers: Headers): CachePlan {
    const directive = headers.get("x-gateway-cache")?.toLowerCase();
    const view = cacheView(req);
    const base = { v: 1, format, route, partition: this.cfg.shareAcrossKeys ? "" : partition };
    const exactKey = sha256(stableStringify({ ...base, request: view }));

    const plan: CachePlan = { lookup: true, store: true, exactKey };
    if (directive === "bypass" || directive === "no-store") return { ...plan, lookup: false, store: false, bypassReason: "client directive" };
    if (!this.cfg.cacheNonDeterministic) {
      const temperature = typeof req.temperature === "number" ? req.temperature : this.cfg.defaultTemperature;
      if (temperature > this.cfg.maxTemperature) {
        return { ...plan, lookup: false, store: false, bypassReason: `temperature ${temperature} > maxTemperature ${this.cfg.maxTemperature}` };
      }
    }
    if (directive === "refresh") plan.lookup = false;

    if (this.embedder) {
      const text = lastUserText(format, req);
      if (text) {
        // Everything except the final user message must match exactly for a semantic hit.
        const prior = { ...view, messages: (view.messages as unknown[]).slice(0, -1) };
        plan.semantic = { scope: sha256(stableStringify({ ...base, embedder: this.embedder.id, prior })), text };
      }
    }
    return plan;
  }

  async lookup(plan: CachePlan, now = Date.now()): Promise<CacheLookupResult> {
    if (!plan.lookup) return { status: plan.bypassReason ? "bypass" : "miss" };
    const exact = await this.store.get(plan.exactKey, now);
    if (exact) return { status: "hit", response: JSON.parse(exact.value), ageSeconds: age(exact.createdAt, now) };

    if (plan.semantic && this.embedder) {
      try {
        plan.semantic.vector = await this.embedder.embed(plan.semantic.text);
      } catch (err) {
        this.logger.warn("semantic cache embedding failed; continuing without it", { error: (err as Error).message });
        plan.semantic = undefined;
        return { status: "miss" };
      }
      const match = await this.store.semanticSearch(plan.semantic.scope, plan.semantic.vector, this.cfg.semantic.threshold, now);
      if (match) {
        return { status: "semantic-hit", response: JSON.parse(match.entry.value), similarity: match.score, ageSeconds: age(match.entry.createdAt, now) };
      }
    }
    return { status: "miss" };
  }

  async save(plan: CachePlan, response: ClientResponse, now = Date.now()): Promise<void> {
    if (!plan.store) return;
    const value = JSON.stringify(response);
    await this.store.set(plan.exactKey, { value, createdAt: now, expiresAt: now + this.cfg.ttlSeconds * 1000 });
    if (plan.semantic && this.embedder) {
      const vector = plan.semantic.vector ?? (await this.embedder.embed(plan.semantic.text));
      const ttl = (this.cfg.semantic.ttlSeconds ?? this.cfg.ttlSeconds) * 1000;
      await this.store.semanticAdd(plan.semantic.scope, vector, { value, createdAt: now, expiresAt: now + ttl });
    }
  }

  close(): Promise<void> {
    return this.store.close();
  }
}

function cacheView(req: ClientRequest): Record<string, unknown> {
  const view: Record<string, unknown> = { ...req };
  for (const f of IGNORED_FIELDS) delete view[f];
  return view;
}

function age(createdAt: number, now: number): number {
  return Math.max(0, Math.round((now - createdAt) / 1000));
}

/** Text of the final message if it is a plain user turn (no images, no tool results). */
export function lastUserText(format: ApiFormat, req: ClientRequest): string | undefined {
  const last = req.messages.at(-1);
  if (!last || last.role !== "user") return undefined;
  if (format === "openai") {
    const content = (last as OAIChatRequest["messages"][number] & { role: "user" }).content;
    if (typeof content !== "string" && content.some((p) => p.type !== "text")) return undefined;
    return oaiContentText(content) || undefined;
  }
  const content = (last as ANTRequest["messages"][number]).content;
  if (typeof content === "string") return content || undefined;
  if (content.some((b: ANTContentBlock) => b.type !== "text")) return undefined;
  return content.map((b) => (b as { text: string }).text).join("\n") || undefined;
}
