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
   * anthropic only: forward temperature/top_p/top_k from OpenAI-format requests.
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

export const ConfigSchema = z
  .object({
    server: z
      .object({
        host: z.string().default("0.0.0.0"),
        port: z.number().int().min(0).max(65535).default(8080),
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
  });

export type GatewayConfig = z.infer<typeof ConfigSchema>;
export type UpstreamConfig = z.infer<typeof UpstreamSchema>;
export type RetryConfig = z.infer<typeof RetrySchema>;
export type RoutingRule = z.infer<typeof RuleSchema>;
export type Target = { upstream: string; model: string };
