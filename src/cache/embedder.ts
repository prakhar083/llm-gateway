import type { EmbedderConfig, GatewayConfig } from "../config/schema.js";
import { upstreamHeaders } from "../upstream/client.js";
import { normalize } from "./store.js";

export interface Embedder {
  /** Identifies the embedding space; part of the semantic scope so switching models never mixes vectors. */
  readonly id: string;
  /** Returns an L2-normalized vector. */
  embed(text: string): Promise<Float32Array>;
}

/** Calls an OpenAI-compatible `/embeddings` endpoint. */
export class OpenAIEmbedder implements Embedder {
  readonly id: string;
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {
    this.id = `openai:${model}`;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ model: this.model, input: text }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`embedding request failed with ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vector = body.data?.[0]?.embedding;
    if (!Array.isArray(vector)) throw new Error("embedding response has no data[0].embedding");
    return normalize(vector);
  }
}

/**
 * Feature-hashing embedder over lowercase word unigrams and bigrams. It needs
 * no model and no network, and catches rephrasings that differ in casing,
 * punctuation or word order, but it has no notion of meaning: "cheap flights
 * to Paris" and "expensive flights to Paris" score high. Use a real embedding
 * model in production.
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;
  constructor(private readonly dimensions = 512) {
    this.id = `hashing:${dimensions}`;
  }

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      // second hash bit picks the sign, which keeps collisions from only ever adding up
      v[h % this.dimensions]! += (h & 0x80000000 ? -1 : 1) * weight;
    };
    words.forEach((w, i) => {
      add(w, 1);
      if (i > 0) add(`${words[i - 1]} ${w}`, 0.5);
    });
    return normalize(v);
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function createEmbedder(cfg: EmbedderConfig, config: GatewayConfig): Embedder {
  if (cfg.type === "hashing") return new HashingEmbedder(cfg.dimensions);
  const upstream = config.upstreams[cfg.upstream]!;
  const url = `${upstream.baseUrl.replace(/\/+$/, "")}/embeddings`;
  return new OpenAIEmbedder(url, upstreamHeaders(upstream), cfg.model, cfg.timeoutMs);
}
