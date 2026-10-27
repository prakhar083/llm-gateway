/**
 * OpenTelemetry GenAI semantic convention attribute names
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/). The GenAI
 * conventions are still in development, so, as the semconv package
 * recommends for incubating attributes, they are pinned here rather than
 * imported from its unstable entry point.
 */
export const GEN_AI = {
  OPERATION_NAME: "gen_ai.operation.name",
  /** Current name of the provider attribute. */
  PROVIDER_NAME: "gen_ai.provider.name",
  /** Deprecated predecessor of gen_ai.provider.name; still emitted for backends that key on it. */
  SYSTEM: "gen_ai.system",
  REQUEST_MODEL: "gen_ai.request.model",
  REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  REQUEST_TOP_P: "gen_ai.request.top_p",
  REQUEST_STREAM: "gen_ai.request.stream",
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
} as const;

/** Gateway-specific attributes, namespaced to avoid colliding with semconv. */
export const GW = {
  ROUTE: "llm_gateway.route",
  RULE: "llm_gateway.routing.rule",
  TARGETS: "llm_gateway.routing.targets",
  ESTIMATED_PROMPT_TOKENS: "llm_gateway.routing.estimated_prompt_tokens",
  UPSTREAM: "llm_gateway.upstream",
  ATTEMPT: "llm_gateway.attempt",
  ATTEMPT_OUTCOME: "llm_gateway.attempt.outcome",
  CACHE_STATUS: "llm_gateway.cache.status",
  CACHE_SIMILARITY: "llm_gateway.cache.similarity",
  KEY: "llm_gateway.key",
  COST_USD: "llm_gateway.cost_usd",
  CLIENT_FORMAT: "llm_gateway.client_format",
} as const;
