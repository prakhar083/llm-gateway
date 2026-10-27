import type { RetryConfig, Target } from "../config/schema.js";
import { GatewayError } from "../errors.js";
import { upstreamErrorMessage } from "../errors.js";
import { callUpstream, ClientAbortedError, UpstreamNetworkError, UpstreamTimeoutError, type UpstreamRequest, type UpstreamResult } from "./client.js";

export type AttemptOutcome = "success" | "retryable_error" | "fatal_error" | "skipped";

export interface AttemptRecord {
  target: Target;
  /** 1-based attempt number on this target. */
  attempt: number;
  outcome: AttemptOutcome;
  status?: number;
  error?: string;
  durationMs: number;
}

/** Hooks let the caller wrap each attempt in a span without the executor knowing about tracing. */
export interface AttemptHooks {
  start?(target: Target, attempt: number): AttemptScope;
}
export interface AttemptScope {
  /** Extra headers (trace context) to send with this attempt. */
  headers?: Record<string, string>;
  end(record: AttemptRecord): void;
}

export interface ExecuteOptions {
  targets: Target[];
  retry: RetryConfig;
  /** Builds the upstream request for a target; may throw GatewayError if the request cannot be expressed there. */
  build(target: Target): UpstreamRequest;
  hooks?: AttemptHooks;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  call?: (req: UpstreamRequest) => Promise<UpstreamResult>;
}

export type ExecuteResult =
  | { ok: true; result: Extract<UpstreamResult, { ok: true }>; target: Target; attempts: AttemptRecord[] }
  /** A non-retryable upstream error (e.g. 400): returned to the client as-is, no fallback. */
  | { ok: false; status: number; errorText: string; target: Target; attempts: AttemptRecord[] };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run the fallback chain: each target gets up to `retry.maxAttempts` attempts
 * with exponential backoff and full jitter; retryable failures that exhaust a
 * target fall over to the next one immediately (no backoff between targets).
 */
export async function executeWithFallback(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { retry } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const call = opts.call ?? callUpstream;
  const attempts: AttemptRecord[] = [];
  let firstBuildError: GatewayError | undefined;
  let last: { status?: number; error: string; timeout: boolean } | undefined;

  for (const target of opts.targets) {
    let req: UpstreamRequest;
    try {
      req = opts.build(target);
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      firstBuildError ??= err;
      attempts.push({ target, attempt: 0, outcome: "skipped", error: err.message, durationMs: 0 });
      continue;
    }

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      const scope = opts.hooks?.start?.(target, attempt);
      const started = performance.now();
      const finish = (r: Omit<AttemptRecord, "target" | "attempt" | "durationMs">) => {
        const record: AttemptRecord = { target, attempt, durationMs: performance.now() - started, ...r };
        attempts.push(record);
        scope?.end(record);
        return record;
      };

      let result: UpstreamResult;
      try {
        result = await call(scope?.headers ? { ...req, headers: { ...req.headers, ...scope.headers } } : req);
      } catch (err) {
        if (err instanceof ClientAbortedError) {
          finish({ outcome: "fatal_error", error: err.message });
          throw err;
        }
        if (!(err instanceof UpstreamTimeoutError || err instanceof UpstreamNetworkError)) throw err;
        finish({ outcome: "retryable_error", error: err.message });
        last = { error: err.message, timeout: err instanceof UpstreamTimeoutError };
        if (attempt < retry.maxAttempts) await sleep(backoff(retry, attempt, undefined, random));
        continue;
      }

      if (result.ok) {
        finish({ outcome: "success", status: result.status });
        return { ok: true, result, target, attempts };
      }

      if (!retry.retryOn.includes(result.status)) {
        finish({ outcome: "fatal_error", status: result.status, error: upstreamErrorMessage(result.errorText) });
        return { ok: false, status: result.status, errorText: result.errorText, target, attempts };
      }

      const message = upstreamErrorMessage(result.errorText);
      finish({ outcome: "retryable_error", status: result.status, error: message });
      last = { status: result.status, error: message, timeout: false };
      if (attempt >= retry.maxAttempts) break;
      const retryAfter = parseRetryAfter(result.headers.get("retry-after"));
      // An upstream asking us to wait longer than we are willing to is better served by the next target.
      if (retryAfter !== undefined && retryAfter > retry.maxDelayMs) break;
      await sleep(backoff(retry, attempt, retryAfter, random));
    }
  }

  if (!last && firstBuildError) throw firstBuildError;
  const summary = summarize(attempts);
  if (last?.status === 429) throw new GatewayError("rate_limit", `all upstream targets are rate limited: ${summary}`);
  if (last?.timeout) throw new GatewayError("timeout", `all upstream targets failed: ${summary}`);
  throw new GatewayError("upstream", `all upstream targets failed: ${summary}`);
}

/** Exponential backoff with full jitter, floored by any Retry-After the upstream sent. */
export function backoff(retry: RetryConfig, attempt: number, retryAfterMs: number | undefined, random: () => number): number {
  const exp = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.round(random() * exp);
  return Math.min(retry.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function summarize(attempts: AttemptRecord[]): string {
  return attempts
    .map((a) => `${a.target.upstream}/${a.target.model}#${a.attempt}: ${a.status ?? ""}${a.status ? " " : ""}${a.error ?? a.outcome}`)
    .join("; ");
}
