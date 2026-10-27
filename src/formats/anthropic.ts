/**
 * The subset of the Anthropic Messages API wire format the gateway reads or
 * writes. Open types, for the same pass-through reason as the OpenAI module.
 */

export interface ANTTextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}
export interface ANTImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}
export interface ANTToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ANTToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<ANTTextBlock | ANTImageBlock>;
  is_error?: boolean;
}
export interface ANTThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export type ANTContentBlock =
  | ANTTextBlock
  | ANTImageBlock
  | ANTToolUseBlock
  | ANTToolResultBlock
  | ANTThinkingBlock
  | { type: string; [key: string]: unknown };

export interface ANTMessage {
  role: "user" | "assistant";
  content: string | ANTContentBlock[];
}

export interface ANTTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  type?: string;
  [key: string]: unknown;
}

export type ANTToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export interface ANTRequest {
  model: string;
  messages: ANTMessage[];
  max_tokens: number;
  system?: string | ANTTextBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: ANTTool[];
  tool_choice?: ANTToolChoice;
  metadata?: { user_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type ANTStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | null;

export interface ANTUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  [key: string]: unknown;
}

export interface ANTResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ANTContentBlock[];
  stop_reason: ANTStopReason;
  stop_sequence: string | null;
  usage: ANTUsage;
  [key: string]: unknown;
}

/** Streaming events, as carried in the `data:` field of each SSE frame. */
export type ANTStreamEvent =
  | { type: "message_start"; message: ANTResponse }
  | { type: "content_block_start"; index: number; content_block: ANTContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
        | { type: string; [key: string]: unknown };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: ANTStopReason; stop_sequence?: string | null };
      usage?: Partial<ANTUsage>;
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

export function antError(message: string, type: string) {
  return { type: "error" as const, error: { type, message } };
}

/** Total prompt-side tokens, including cache reads and writes. */
export function antInputTokens(u: Partial<ANTUsage> | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
