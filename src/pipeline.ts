import type { GatewayConfig } from "./config/schema.js";
import { routeRequest } from "./routing/router.js";
import { executeWithFallback } from "./upstream/executor.js";
import { errorBody, GatewayError, kindForStatus, upstreamErrorMessage, type ApiFormat } from "./errors.js";
import type { ANTRequest } from "./formats/anthropic.js";
import type { OAIChatRequest } from "./formats/openai.js";
import type { Logger } from "./logger.js";
import { eventStream, sseDecoderStream, sseEncoderStream, type SSEEvent } from "./sse.js";
import {
  accumulator,
  buildUpstreamBody,
  responseToEvents,
  streamTranslator,
  toClientResponse,
  usageFilter,
  usageOf,
  type ClientRequest,
  type ClientResponse,
  type Usage,
} from "./translate/adapter.js";
import { translatorStream } from "./translate/stream.js";

export interface PipelineDeps {
  config: GatewayConfig;
  logger: Logger;
  /** Injected in tests to make backoff instant and deterministic. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface ChatCall {
  format: ApiFormat;
  body: ClientRequest;
  headers: Headers;
  signal?: AbortSignal;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

export function validateRequest(format: ApiFormat, body: unknown): ClientRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new GatewayError("invalid_request", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.model !== "string" || !b.model) throw new GatewayError("invalid_request", "`model` is required");
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    throw new GatewayError("invalid_request", "`messages` must be a non-empty array");
  }
  if (format === "anthropic" && typeof b.max_tokens !== "number") {
    throw new GatewayError("invalid_request", "`max_tokens` is required");
  }
  return format === "openai" ? (b as OAIChatRequest) : (b as unknown as ANTRequest);
}

export function errorResponse(format: ApiFormat, err: GatewayError, headers: Record<string, string> = {}): Response {
  return Response.json(errorBody(format, err.kind, err.message), { status: err.status, headers: { ...headers, ...err.headers } });
}

export async function handleChat(deps: PipelineDeps, call: ChatCall): Promise<Response> {
  const { config } = deps;
  const { format, body } = call;
  const stream = Boolean(body.stream);
  const decision = routeRequest(config, format, body, call.headers);

  const executed = await executeWithFallback({
    targets: decision.targets,
    retry: config.retry,
    sleep: deps.sleep,
    random: deps.random,
    build: (target) => {
      const upstream = config.upstreams[target.upstream]!;
      return {
        name: target.upstream,
        upstream,
        body: buildUpstreamBody(format, body, target.model, upstream),
        stream,
        headers: passthroughHeaders(format, upstream.type, call.headers),
        signal: call.signal,
      };
    },
  });

  const { target, attempts } = executed;
  const upstream = config.upstreams[target.upstream]!;
  const headers: Record<string, string> = {
    "x-gateway-route": decision.route,
    "x-gateway-upstream": target.upstream,
    "x-gateway-model": target.model,
    "x-gateway-attempts": String(attempts.filter((a) => a.outcome !== "skipped").length),
  };

  if (!executed.ok) {
    return errorResponse(
      format,
      new GatewayError(kindForStatus(executed.status), upstreamErrorMessage(executed.errorText), { status: executed.status }),
      headers,
    );
  }
  const result = executed.result;

  if (result.stream === undefined) {
    // Non-streaming request, or an upstream that answered a streaming request with plain JSON.
    const response = toClientResponse(format, upstream.type, result.json);
    if (!stream) return Response.json(response, { headers });
    return streamResponse(format, body, eventStream(responseToEvents(format, response)), headers, () => {});
  }

  const translated = result.stream.pipeThrough(sseDecoderStream()).pipeThrough(translatorStream(streamTranslator(format, upstream.type)));
  return streamResponse(format, body, translated, headers, () => {});
}

/** Same-format Anthropic traffic keeps the client's API version and beta flags. */
function passthroughHeaders(format: ApiFormat, upstreamType: ApiFormat, headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  if (format === "anthropic" && upstreamType === "anthropic") {
    const version = headers.get("anthropic-version");
    const beta = headers.get("anthropic-beta");
    if (version) out["anthropic-version"] = version;
    if (beta) out["anthropic-beta"] = beta;
  }
  return out;
}

/**
 * Final leg of every streaming response:
 *   client-format events -> accumulate -> hide usage if not requested -> finalize -> bytes
 * `onComplete` runs when the upstream stream ends and may append SSE comments.
 */
function streamResponse(
  format: ApiFormat,
  req: ClientRequest,
  events: ReadableStream<SSEEvent>,
  headers: Record<string, string>,
  onComplete: (res: ClientResponse | undefined, usage: Usage | undefined) => string[] | void,
): Response {
  const acc = accumulator(format);
  const tap = new TransformStream<SSEEvent, SSEEvent>({
    transform(ev, controller) {
      acc.push(ev);
      controller.enqueue(ev);
    },
  });
  const finalize = new TransformStream<SSEEvent, SSEEvent | string>({
    flush(controller) {
      let res: ClientResponse | undefined;
      try {
        res = acc.complete ? acc.result() : undefined;
      } catch {
        res = undefined;
      }
      for (const comment of onComplete(res, res ? usageOf(format, res) : undefined) ?? []) controller.enqueue(comment);
    },
  });
  const body = events
    .pipeThrough(tap)
    .pipeThrough(translatorStream(usageFilter(format, req)))
    .pipeThrough(finalize)
    .pipeThrough(sseEncoderStream());
  return new Response(body, { headers: { ...SSE_HEADERS, ...headers } });
}
