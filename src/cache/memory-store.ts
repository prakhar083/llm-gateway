import { dot, type CacheEntry, type CacheStore, type SemanticMatch } from "./store.js";

interface SemanticItem {
  vector: Float32Array;
  entry: CacheEntry;
}

/**
 * In-process store. The exact tier is an LRU bounded by `maxEntries`; the
 * semantic tier is a brute-force scan within one scope (model + system prompt +
 * prior conversation), which stays fast because scopes are small.
 */
export class MemoryCacheStore implements CacheStore {
  private exact = new Map<string, CacheEntry>();
  private semantic = new Map<string, SemanticItem[]>();
  private semanticCount = 0;

  constructor(private readonly maxEntries = 10_000) {}

  async get(key: string, now = Date.now()) {
    const entry = this.exact.get(key);
    if (!entry) return undefined;
    this.exact.delete(key);
    if (entry.expiresAt <= now) return undefined;
    this.exact.set(key, entry); // refresh LRU position
    return entry;
  }

  async set(key: string, entry: CacheEntry) {
    this.exact.delete(key);
    this.exact.set(key, entry);
    while (this.exact.size > this.maxEntries) this.exact.delete(this.exact.keys().next().value!);
  }

  async semanticSearch(scope: string, vector: Float32Array, threshold: number, now = Date.now()): Promise<SemanticMatch | undefined> {
    const items = this.semantic.get(scope);
    if (!items) return undefined;
    let best: SemanticMatch | undefined;
    const live = items.filter((i) => i.entry.expiresAt > now);
    this.semanticCount -= items.length - live.length;
    if (live.length) this.semantic.set(scope, live);
    else this.semantic.delete(scope);
    for (const item of live) {
      const score = dot(vector, item.vector);
      if (score >= threshold && (!best || score > best.score)) best = { entry: item.entry, score };
    }
    return best;
  }

  async semanticAdd(scope: string, vector: Float32Array, entry: CacheEntry) {
    const items = this.semantic.get(scope) ?? [];
    items.push({ vector, entry });
    this.semantic.set(scope, items);
    this.semanticCount++;
    // Evict oldest scopes first when over budget.
    for (const [s, list] of this.semantic) {
      if (this.semanticCount <= this.maxEntries) break;
      this.semanticCount -= list.length;
      this.semantic.delete(s);
    }
  }

  async close() {
    this.exact.clear();
    this.semantic.clear();
  }
}
