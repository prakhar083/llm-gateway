/**
 * The subset of the OpenAI Chat Completions wire format the gateway reads or
 * writes. Types are intentionally open (`[key: string]: unknown`) because a
 * proxy must pass through fields it does not understand.
 */

export interface OAITextPart {
  type: "text";
  text: string;
}
export interface OAIImagePart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}
export type OAIContentPart = OAITextPart | OAIImagePart | { type: string; [key: string]: unknown };

export interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OAIMessage =
  | { role: "system" | "developer"; content: string | OAIContentPart[]; name?: string }
  | { role: "user"; content: string | OAIContentPart[]; name?: string }
  | {
      role: "assistant";
      content?: string | OAIContentPart[] | null;
      tool_calls?: OAIToolCall[];
      refusal?: string | null;
      name?: string;
    }
  | { role: "tool"; content: string | OAIContentPart[]; tool_call_id: string };

export interface OAITool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

export type OAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OAIChatRequest {
  model: string;
  messages: OAIMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean } | null;
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  n?: number | null;
  stop?: string | string[] | null;
  tools?: OAITool[];
  tool_choice?: OAIToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: { type: string; json_schema?: { name?: string; schema?: Record<string, unknown>; strict?: boolean } };
  user?: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

export type OAIFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null;

export interface OAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface OAIChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[]; refusal?: string | null };
    finish_reason: OAIFinishReason;
    logprobs?: unknown;
  }>;
  usage?: OAIUsage;
  [key: string]: unknown;
}

export interface OAIChunkToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: "assistant"; content?: string | null; tool_calls?: OAIChunkToolCallDelta[]; refusal?: string | null };
    finish_reason: OAIFinishReason;
  }>;
  usage?: OAIUsage | null;
}

export function oaiError(message: string, type: string, code: string | null = null) {
  return { error: { message, type, param: null, code } };
}

/** Flatten string-or-parts content into plain text (non-text parts are dropped). */
export function oaiContentText(content: string | OAIContentPart[] | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p): p is OAITextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}
