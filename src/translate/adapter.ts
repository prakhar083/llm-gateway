/**
 * Chooses the right translation for a (client format, upstream type) pair.
 * Same-format traffic is passed through with only the model swapped.
 */
import type { UpstreamConfig } from "../config/schema.js";
import type { ApiFormat } from "../errors.js";
import { antInputTokens, type ANTRequest, type ANTResponse } from "../formats/anthropic.js";
import type { OAIChatCompletion, OAIChatRequest } from "../formats/openai.js";
import { AnthropicAccumulator, HideUsageStream, IdentityStream, OpenAIAccumulator, type Accumulator } from "./accumulate.js";
import { anthropicToOpenaiRequest, openaiToAnthropicRequest } from "./request.js";
import { anthropicResponseToOpenai, openaiResponseToAnthropic } from "./response.js";
import { AnthropicToOpenAIStream, OpenAIToAnthropicStream, type StreamTranslator } from "./stream.js";
import { anthropicMessageToEvents, openaiCompletionToEvents } from "./synthesize.js";
import type { SSEEvent } from "../sse.js";

export type ClientRequest = OAIChatRequest | ANTRequest;
export type ClientResponse = OAIChatCompletion | ANTResponse;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens served from the provider's prompt cache. */
  cachedInputTokens: number;
}

export function buildUpstreamBody(format: ApiFormat, req: ClientRequest, model: string, upstream: UpstreamConfig): unknown {
  if (format === "openai") {
    const r = req as OAIChatRequest;
    if (upstream.type === "anthropic") return openaiToAnthropicRequest(r, model, upstream);
    const { metadata: _metadata, ...rest } = r;
    const body: OAIChatRequest = { ...rest, model };
    if (r.stream) body.stream_options = { ...r.stream_options, include_usage: true };
    return body;
  }
  const r = req as ANTRequest;
  if (upstream.type === "openai") return anthropicToOpenaiRequest(r, model, upstream);
  const body: ANTRequest = { ...r, model };
  // The Messages API only accepts `user_id` in metadata; routing metadata stays at the gateway.
  if (r.metadata) {
    if (r.metadata.user_id) body.metadata = { user_id: r.metadata.user_id };
    else delete body.metadata;
  }
  return body;
}

export function toClientResponse(format: ApiFormat, upstreamType: ApiFormat, json: unknown): ClientResponse {
  if (format === upstreamType) return json as ClientResponse;
  return format === "openai" ? anthropicResponseToOpenai(json as ANTResponse) : openaiResponseToAnthropic(json as OAIChatCompletion);
}

/** Upstream SSE -> client SSE. OpenAI-format output always carries usage; `hideUsage` strips it later. */
export function streamTranslator(format: ApiFormat, upstreamType: ApiFormat): StreamTranslator {
  if (format === upstreamType) return new IdentityStream();
  return format === "openai" ? new AnthropicToOpenAIStream(true) : new OpenAIToAnthropicStream();
}

export function usageFilter(format: ApiFormat, req: ClientRequest): StreamTranslator {
  if (format !== "openai") return new IdentityStream();
  return new HideUsageStream(Boolean((req as OAIChatRequest).stream_options?.include_usage));
}

export function accumulator(format: ApiFormat): Accumulator<ClientResponse> {
  return format === "openai" ? new OpenAIAccumulator() : new AnthropicAccumulator();
}

export function responseToEvents(format: ApiFormat, res: ClientResponse): SSEEvent[] {
  return format === "openai" ? openaiCompletionToEvents(res as OAIChatCompletion, true) : anthropicMessageToEvents(res as ANTResponse);
}

export function usageOf(format: ApiFormat, res: ClientResponse): Usage {
  if (format === "openai") {
    const u = (res as OAIChatCompletion).usage;
    return {
      inputTokens: u?.prompt_tokens ?? 0,
      outputTokens: u?.completion_tokens ?? 0,
      cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    };
  }
  const u = (res as ANTResponse).usage;
  return { inputTokens: antInputTokens(u), outputTokens: u?.output_tokens ?? 0, cachedInputTokens: u?.cache_read_input_tokens ?? 0 };
}

export function finishReasonOf(format: ApiFormat, res: ClientResponse): string | null {
  return format === "openai" ? ((res as OAIChatCompletion).choices[0]?.finish_reason ?? null) : (res as ANTResponse).stop_reason;
}

export function responseModelOf(res: ClientResponse): string {
  return res.model;
}
