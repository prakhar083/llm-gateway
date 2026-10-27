/**
 * Turn a complete response object into the SSE event sequence a streaming
 * client expects. Used to replay cache hits to streaming clients and to cope
 * with upstreams that answer a streaming request with a plain JSON body.
 */
import type { ANTResponse } from "../formats/anthropic.js";
import type { OAIChatChunk, OAIChatCompletion } from "../formats/openai.js";
import type { SSEEvent } from "../sse.js";
import { antEvent } from "./stream.js";

export function openaiCompletionToEvents(res: OAIChatCompletion, includeUsage: boolean): SSEEvent[] {
  const base = { id: res.id, object: "chat.completion.chunk" as const, created: res.created, model: res.model };
  const choice = res.choices[0];
  const chunk = (delta: OAIChatChunk["choices"][number]["delta"], finish: OAIChatChunk["choices"][number]["finish_reason"] = null): SSEEvent => ({
    data: JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] } satisfies OAIChatChunk),
  });

  const out: SSEEvent[] = [chunk({ role: "assistant", content: "" })];
  if (choice?.message.content) out.push(chunk({ content: choice.message.content }));
  choice?.message.tool_calls?.forEach((tc, index) => {
    out.push(chunk({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }));
  });
  out.push(chunk({}, choice?.finish_reason ?? "stop"));
  if (includeUsage && res.usage) {
    out.push({ data: JSON.stringify({ ...base, choices: [], usage: res.usage } satisfies OAIChatChunk) });
  }
  out.push({ data: "[DONE]" });
  return out;
}

export function anthropicMessageToEvents(res: ANTResponse): SSEEvent[] {
  const out: SSEEvent[] = [
    antEvent({
      type: "message_start",
      message: { ...res, content: [], stop_reason: null, stop_sequence: null, usage: { ...res.usage, output_tokens: 0 } },
    }),
  ];
  res.content.forEach((block, index) => {
    const b = block as Record<string, unknown>;
    switch (block.type) {
      case "text":
        out.push(antEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
        out.push(antEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text as string } }));
        break;
      case "tool_use":
        out.push(antEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id as string, name: b.name as string, input: {} } }));
        out.push(antEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } }));
        break;
      case "thinking":
        out.push(antEvent({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }));
        if (b.thinking) out.push(antEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking as string } }));
        if (b.signature) out.push(antEvent({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature as string } }));
        break;
      default:
        // Blocks without a delta form (e.g. redacted_thinking, server tool results) arrive whole in content_block_start.
        out.push(antEvent({ type: "content_block_start", index, content_block: block }));
    }
    out.push(antEvent({ type: "content_block_stop", index }));
  });
  out.push(
    antEvent({ type: "message_delta", delta: { stop_reason: res.stop_reason, stop_sequence: res.stop_sequence }, usage: { output_tokens: res.usage.output_tokens } }),
    antEvent({ type: "message_stop" }),
  );
  return out;
}
