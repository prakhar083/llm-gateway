import type { UpstreamConfig } from "../config/schema.js";

export class UpstreamTimeoutError extends Error {
  constructor(upstream: string, ms: number) {
    super(`upstream "${upstream}" did not respond within ${ms}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

export class UpstreamNetworkError extends Error {
  constructor(upstream: string, cause: unknown) {
    super(`network error calling upstream "${upstream}": ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "UpstreamNetworkError";
  }
}

export class ClientAbortedError extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientAbortedError";
  }
}

export interface UpstreamRequest {
  name: string;
  upstream: UpstreamConfig;
  body: unknown;
  stream: boolean;
  /** Extra headers such as `anthropic-version` passthrough or W3C trace context. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type UpstreamResult =
  | { ok: true; status: number; headers: Headers; json: unknown; stream?: undefined }
  | { ok: true; status: number; headers: Headers; stream: ReadableStream<Uint8Array>; json?: undefined }
  | { ok: false; status: number; headers: Headers; errorText: string };

export function upstreamUrl(u: UpstreamConfig): string {
  const base = u.baseUrl.replace(/\/+$/, "");
  return u.type === "openai" ? `${base}/chat/completions` : `${base}/v1/messages`;
}

export function upstreamHeaders(u: UpstreamConfig, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (u.type === "openai") {
    if (u.apiKey) h.authorization = `Bearer ${u.apiKey}`;
  } else {
    if (u.apiKey) h["x-api-key"] = u.apiKey;
    h["anthropic-version"] = u.anthropicVersion;
  }
  return { ...h, ...extra, ...u.headers };
}

/**
 * One HTTP attempt against an upstream. The timeout covers the whole exchange
 * for non-streaming calls and time-to-headers for streaming calls; once a
 * stream has started, its lifetime is bounded by the client connection.
 */
export async function callUpstream(req: UpstreamRequest): Promise<UpstreamResult> {
  const { upstream } = req;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new UpstreamTimeoutError(req.name, upstream.timeoutMs)), upstream.timeoutMs);
  const signal = req.signal ? AbortSignal.any([controller.signal, req.signal]) : controller.signal;

  const fail = (err: unknown): never => {
    clearTimeout(timer);
    if (req.signal?.aborted) throw new ClientAbortedError();
    if (controller.signal.aborted) throw controller.signal.reason;
    throw new UpstreamNetworkError(req.name, err);
  };

  let res: Response;
  try {
    res = await fetch(upstreamUrl(upstream), {
      method: "POST",
      headers: upstreamHeaders(upstream, req.headers),
      body: JSON.stringify(req.body),
      signal,
    });
  } catch (err) {
    return fail(err);
  }

  try {
    if (!res.ok) {
      const errorText = await res.text();
      clearTimeout(timer);
      return { ok: false, status: res.status, headers: res.headers, errorText };
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (req.stream && res.body && contentType.includes("text/event-stream")) {
      clearTimeout(timer);
      return { ok: true, status: res.status, headers: res.headers, stream: res.body };
    }
    const text = await res.text();
    clearTimeout(timer);
    try {
      return { ok: true, status: res.status, headers: res.headers, json: JSON.parse(text) };
    } catch {
      return { ok: false, status: 502, headers: res.headers, errorText: `upstream returned non-JSON body: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return fail(err);
  }
}
