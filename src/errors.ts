import { antError } from "./formats/anthropic.js";
import { oaiError } from "./formats/openai.js";

/** The two client-facing wire formats. Upstream `type` uses the same names. */
export type ApiFormat = "openai" | "anthropic";

export type ErrorKind =
  | "invalid_request"
  | "authentication"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "budget_exceeded"
  | "upstream"
  | "timeout";

const MAP: Record<ErrorKind, { status: number; openaiType: string; openaiCode: string | null; anthropicType: string }> = {
  invalid_request: { status: 400, openaiType: "invalid_request_error", openaiCode: null, anthropicType: "invalid_request_error" },
  authentication: { status: 401, openaiType: "invalid_request_error", openaiCode: "invalid_api_key", anthropicType: "authentication_error" },
  permission: { status: 403, openaiType: "permission_error", openaiCode: null, anthropicType: "permission_error" },
  not_found: { status: 404, openaiType: "invalid_request_error", openaiCode: "model_not_found", anthropicType: "not_found_error" },
  rate_limit: { status: 429, openaiType: "rate_limit_error", openaiCode: "rate_limit_exceeded", anthropicType: "rate_limit_error" },
  budget_exceeded: { status: 402, openaiType: "insufficient_quota", openaiCode: "budget_exceeded", anthropicType: "billing_error" },
  upstream: { status: 502, openaiType: "api_error", openaiCode: "upstream_error", anthropicType: "api_error" },
  timeout: { status: 504, openaiType: "api_error", openaiCode: "upstream_timeout", anthropicType: "timeout_error" },
};

export class GatewayError extends Error {
  readonly status: number;
  constructor(
    readonly kind: ErrorKind,
    message: string,
    opts: { status?: number; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = opts.status ?? MAP[kind].status;
    this.headers = opts.headers ?? {};
  }
  readonly headers: Record<string, string>;
}

export function errorBody(format: ApiFormat, kind: ErrorKind, message: string): unknown {
  const m = MAP[kind];
  return format === "openai" ? oaiError(message, m.openaiType, m.openaiCode) : antError(message, m.anthropicType);
}

/** Map an arbitrary upstream HTTP status onto an error kind for re-encoding. */
export function kindForStatus(status: number): ErrorKind {
  if (status === 400 || status === 413 || status === 422) return "invalid_request";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 402) return "budget_exceeded";
  if (status === 408 || status === 504) return "timeout";
  return "upstream";
}

/** Best-effort extraction of a human-readable message from either provider's error body. */
export function upstreamErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 500) || "upstream returned an empty error body";
}
