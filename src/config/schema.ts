import { z } from "zod";

const UpstreamSchema = z.object({
  /** Wire protocol the upstream speaks. `openai` covers OpenAI, Groq, Ollama, vLLM, LM Studio... */
  type: z.enum(["openai", "anthropic"]),
  /** For `openai` this includes the version prefix (https://api.openai.com/v1); for `anthropic` it does not. */
  baseUrl: z.url(),
  apiKey: z.string().optional(),
  /** Non-streaming: whole request. Streaming: time until response headers arrive. */
  timeoutMs: z.number().int().positive().default(60_000),
  headers: z.record(z.string(), z.string()).default({}),
  /** anthropic only: `anthropic-version` sent on translated requests. */
  anthropicVersion: z.string().default("2023-06-01"),
  /** anthropic only: `max_tokens` is required by the Messages API; used when the client omits it. */
  defaultMaxTokens: z.number().int().positive().default(4096),
  /**
   * anthropic only: forward temperature/top_p from OpenAI-format requests.
   * Off by default because current Claude models reject non-default sampling parameters.
   */
  forwardSamplingParams: z.boolean().default(false),
  /** openai only: some newer OpenAI models only accept `max_completion_tokens`. */
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
});

/** `upstream/model` shorthand or an explicit object. */
const TargetSchema = z.union([
  z
    .string()
    .regex(/^[^/]+\/.+$/, "target shorthand must look like `upstream/model`")
    .transform((s) => {
      const i = s.indexOf("/");
      return { upstream: s.slice(0, i), model: s.slice(i + 1) };
    }),
  z.object({ upstream: z.string(), model: z.string() }),
]);

const ModelAliasSchema = z.object({
  description: z.string().optional(),
  /** Ordered fallback chain: the first target is tried first. */
  targets: z.array(TargetSchema).min(1),
});

const RuleSchema = z.object({
  name: z.string().optional(),
  /** Every condition present must match. */
  when: z
    .object({
      /** Requested model name(s) as sent by the client. */
      model: z.union([z.string(), z.array(z.string())]).optional(),
      /** Header name -> exact value, or "*" for "present". Names are case-insensitive. */
      header: z.record(z.string(), z.string()).optional(),
      /** Keys in the request body's `metadata` object. */
      metadata: z.record(z.string(), z.string()).optional(),
      /** Bounds on the estimated prompt size (characters / 4). */
      minPromptTokens: z.number().int().nonnegative().optional(),
      maxPromptTokens: z.number().int().positive().optional(),
    })
    .refine((w) => Object.keys(w).length > 0, { message: "a rule needs at least one condition" }),
  /** Model alias to use when the rule matches. */
  route: z.string(),
});

const RetrySchema = z.object({
  /** Attempts per target before falling over to the next one. */
  maxAttempts: z.number().int().min(1).max(10).default(2),
  baseDelayMs: z.number().int().nonnegative().default(250),
  maxDelayMs: z.number().int().nonnegative().default(4_000),
  /** HTTP statuses that are retried and then fall over. Timeouts and network errors always are. */
  retryOn: z.array(z.number().int()).default([408, 409, 429, 500, 502, 503, 504, 529]),
});

const CacheStoreSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("memory"), maxEntries: z.number().int().positive().default(10_000) }),
  z.object({ type: z.literal("sqlite"), path: z.string().default("./llm-gateway-cache.db") }),
]);

const EmbedderSchema = z.discriminatedUnion("type", [
  /** Any OpenAI-compatible /embeddings endpoint (OpenAI, Ollama, vLLM, TEI...). */
  z.object({ type: z.literal("openai"), upstream: z.string(), model: z.string(), timeoutMs: z.number().int().positive().default(5_000) }),
  /** Local feature-hashing embedder: no network, lexical similarity only. */
  z.object({ type: z.literal("hashing"), dimensions: z.number().int().min(16).max(8192).default(512) }),
]);

const CacheSchema = z.object({
  enabled: z.boolean().default(false),
  ttlSeconds: z.number().int().positive().default(3_600),
  /** Requests whose effective temperature is above this are never cached... */
  maxTemperature: z.number().min(0).default(0),
  /** ...where "effective" means this value when the request omits temperature (provider default is 1). */
  defaultTemperature: z.number().min(0).default(1),
  /** ...unless this is set. */
  cacheNonDeterministic: z.boolean().default(false),
  /** By default entries are partitioned per virtual key so tenants never see each other's responses. */
  shareAcrossKeys: z.boolean().default(false),
  store: CacheStoreSchema.default({ type: "memory", maxEntries: 10_000 }),
  semantic: z
    .object({
      enabled: z.boolean().default(false),
      /** Cosine similarity required for a semantic hit. */
      threshold: z.number().min(0).max(1).default(0.95),
      ttlSeconds: z.number().int().positive().optional(),
      embedder: EmbedderSchema.default({ type: "hashing", dimensions: 512 }),
    })
    .prefault({}),
});

const VirtualKeySchema = z.object({
  /** Stable identifier used in metrics, logs and the spend ledger. */
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/, "key names may only contain letters, digits, _ . -"),
  /** The secret clients send as `Authorization: Bearer ...` or `x-api-key`. Use ${ENV} interpolation. */
  key: z.string().min(1),
  budgetUsdMonthly: z.number().positive().optional(),
  requestsPerMinute: z.number().positive().optional(),
  /** Token-bucket capacity; defaults to requestsPerMinute (one minute of burst). */
  burst: z.number().int().positive().optional(),
  /** Allowed routes (aliases or `upstream/model`); all when omitted. */
  models: z.array(z.string()).optional(),
});

const PriceSchema = z.object({
  /** USD per million tokens. */
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  /** Price for prompt-cache reads; defaults to `input`. */
  cachedInput: z.number().nonnegative().optional(),
  /** Some models charge more above a prompt-size threshold. */
  longContext: z
    .object({ thresholdTokens: z.number().int().positive(), input: z.number().nonnegative(), output: z.number().nonnegative() })
    .optional(),
});

export const ConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().default("0.0.0.0"),
        // coerced so it can come from the environment: `port: ${PORT:-8080}`
        port: z.coerce.number().int().min(0).max(65535).default(8080),
        /** Max accepted request body in bytes. */
        bodyLimitBytes: z.number().int().positive().default(10 * 1024 * 1024),
      })
      .prefault({}),
    upstreams: z.record(z.string(), UpstreamSchema).refine((u) => Object.keys(u).length > 0, {
      message: "at least one upstream is required",
    }),
    models: z.record(z.string(), ModelAliasSchema).default({}),
    routing: z
      .object({
        rules: z.array(RuleSchema).default([]),
        /** Allow clients to bypass aliases with `upstream/model`. */
        allowDirect: z.boolean().default(true),
      })
      .prefault({}),
    retry: RetrySchema.prefault({}),
    cache: CacheSchema.prefault({}),
    auth: z
      .object({
        keys: z.array(VirtualKeySchema).default([]),
        /** Defaults to true when any key is configured. */
        required: z.boolean().optional(),
      })
      .prefault({}),
    budgets: z
      .object({
        store: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("memory") }),
            z.object({ type: z.literal("sqlite"), path: z.string().default("./llm-gateway-spend.db") }),
          ])
          .default({ type: "memory" }),
      })
      .prefault({}),
    telemetry: z
      .object({
        serviceName: z.string().default("llm-gateway"),
        tracing: z
          .object({
            enabled: z.boolean().default(false),
            /** OTLP/HTTP traces endpoint; falls back to OTEL_EXPORTER_OTLP_TRACES_ENDPOINT. */
            otlpEndpoint: z.string().optional(),
            /** Fraction of root spans sampled (parent-based). */
            sampleRatio: z.number().min(0).max(1).default(1),
          })
          .prefault({}),
        metrics: z.object({ enabled: z.boolean().default(true), path: z.string().default("/metrics") }).prefault({}),
        /** Write one JSON access-log line per request. */
        accessLog: z.boolean().default(true),
      })
      .prefault({}),
    /** Merged over the built-in table. Keys are upstream model ids; a trailing `*` matches a prefix. */
    pricing: z.record(z.string(), PriceSchema).default({}),
  })
  .superRefine((cfg, ctx) => {
    for (const [alias, def] of Object.entries(cfg.models)) {
      def.targets.forEach((t, i) => {
        if (!cfg.upstreams[t.upstream]) {
          ctx.addIssue({
            code: "custom",
            path: ["models", alias, "targets", i],
            message: `unknown upstream "${t.upstream}"`,
          });
        }
      });
    }
    cfg.routing.rules.forEach((rule, i) => {
      if (!cfg.models[rule.route]) {
        ctx.addIssue({ code: "custom", path: ["routing", "rules", i, "route"], message: `unknown model alias "${rule.route}"` });
      }
    });
    const names = new Set<string>();
    const secrets = new Set<string>();
    cfg.auth.keys.forEach((k, i) => {
      if (names.has(k.name)) ctx.addIssue({ code: "custom", path: ["auth", "keys", i, "name"], message: `duplicate key name "${k.name}"` });
      if (secrets.has(k.key)) ctx.addIssue({ code: "custom", path: ["auth", "keys", i, "key"], message: "duplicate key secret" });
      names.add(k.name);
      secrets.add(k.key);
    });
    const emb = cfg.cache.semantic.embedder;
    if (emb.type === "openai") {
      const up = cfg.upstreams[emb.upstream];
      if (!up) ctx.addIssue({ code: "custom", path: ["cache", "semantic", "embedder", "upstream"], message: `unknown upstream "${emb.upstream}"` });
      else if (up.type !== "openai") {
        ctx.addIssue({ code: "custom", path: ["cache", "semantic", "embedder", "upstream"], message: "embedder upstream must be of type openai" });
      }
    }
  });

export type GatewayConfig = z.infer<typeof ConfigSchema>;
export type UpstreamConfig = z.infer<typeof UpstreamSchema>;
export type TelemetryConfig = GatewayConfig["telemetry"];
export type VirtualKeyConfig = z.infer<typeof VirtualKeySchema>;
export type Price = z.infer<typeof PriceSchema>;
export type CacheConfig = z.infer<typeof CacheSchema>;
export type EmbedderConfig = z.infer<typeof EmbedderSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type RoutingRule = z.infer<typeof RuleSchema>;
export type Target = { upstream: string; model: string };
