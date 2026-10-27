import {
  antInputTokens,
  type ANTContentBlock,
  type ANTResponse,
  type ANTStopReason,
  type ANTUsage,
} from "../formats/anthropic.js";
import type { OAIChatCompletion, OAIFinishReason, OAIToolCall, OAIUsage } from "../formats/openai.js";

export function anthropicStopToOpenai(reason: ANTStopReason | undefined): OAIFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return null;
  }
}

export function openaiFinishToAnthropic(reason: OAIFinishReason | string | undefined): ANTStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return reason == null ? null : "end_turn";
  }
}

export function anthropicUsageToOpenai(u: Partial<ANTUsage> | undefined): OAIUsage {
  const prompt = antInputTokens(u);
  const completion = u?.output_tokens ?? 0;
  const usage: OAIUsage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  if (u?.cache_read_input_tokens) usage.prompt_tokens_details = { cached_tokens: u.cache_read_input_tokens };
  return usage;
}

export function openaiUsageToAnthropic(u: OAIUsage | null | undefined): ANTUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: ANTUsage = { input_tokens: (u?.prompt_tokens ?? 0) - cached, output_tokens: u?.completion_tokens ?? 0 };
  if (cached) usage.cache_read_input_tokens = cached;
  return usage;
}

export function anthropicResponseToOpenai(res: ANTResponse, created = Math.floor(Date.now() / 1000)): OAIChatCompletion {
  let text = "";
  const toolCalls: OAIToolCall[] = [];
  for (const b of res.content) {
    if (b.type === "text") text += (b as { text: string }).text;
    else if (b.type === "tool_use") {
      const u = b as { id: string; name: string; input: unknown };
      toolCalls.push({ id: u.id, type: "function", function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } });
    }
    // thinking blocks are not representable in Chat Completions and are dropped.
  }
  const message: OAIChatCompletion["choices"][number]["message"] = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl-${res.id}`,
    object: "chat.completion",
    created,
    model: res.model,
    choices: [{ index: 0, message, finish_reason: anthropicStopToOpenai(res.stop_reason), logprobs: null }],
    usage: anthropicUsageToOpenai(res.usage),
  };
}

export function openaiResponseToAnthropic(res: OAIChatCompletion): ANTResponse {
  const choice = res.choices[0];
  const content: ANTContentBlock[] = [];
  const text = choice?.message.content;
  if (text) content.push({ type: "text", text });
  for (const call of choice?.message.tool_calls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
  }
  return {
    id: res.id.startsWith("msg_") ? res.id : `msg_${res.id}`,
    type: "message",
    role: "assistant",
    model: res.model,
    content,
    stop_reason: openaiFinishToAnthropic(choice?.finish_reason ?? undefined),
    stop_sequence: null,
    usage: openaiUsageToAnthropic(res.usage),
  };
}

/** OpenAI tool arguments are a JSON string; models occasionally emit invalid JSON. */
export function parseArgs(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw_arguments: args };
  }
}
