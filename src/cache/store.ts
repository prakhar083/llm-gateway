export interface CacheEntry {
  /** Serialized client-format response. */
  value: string;
  createdAt: number;
  expiresAt: number;
}

export interface SemanticMatch {
  entry: CacheEntry;
  score: number;
}

/** Storage backend for both cache tiers. Vectors are L2-normalized by the caller. */
export interface CacheStore {
  get(key: string, now?: number): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
  /** Best match in `scope` with cosine similarity >= threshold. */
  semanticSearch(scope: string, vector: Float32Array, threshold: number, now?: number): Promise<SemanticMatch | undefined>;
  semanticAdd(scope: string, vector: Float32Array, entry: CacheEntry): Promise<void>;
  close(): Promise<void>;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}
