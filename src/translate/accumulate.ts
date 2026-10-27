/**
 * Accumulators rebuild a complete response object from a stream of SSE events
 * in the client's format. The gateway uses them to read usage for cost
 * accounting and to store streamed responses in the cache.
 */
import type { ANTContentBlock, ANTResponse, ANTStreamEvent } from "../formats/anthropic.js";
import type { OAIChatChunk, OAIChatCompletion, OAIFinishReason, OAIToolCall, OAIUsage } from "../formats/openai.js";
import type { SSEEvent } from "../sse.js";
import { parseArgs } from "./response.js";
import type { StreamTranslator } from "./stream.js";

export interface Accumulator<T> {
  push(ev: SSEEvent): void;
  /** True once the stream reached its normal terminal event. */
  readonly complete: boolean;
  /** True if the stream carried an error event. */
  readonly errored: boolean;
  result(): T;
}

export class OpenAIAccumulator implements Accumulator<OAIChatCompletion> {
  complete = false;
  errored = false;
  private id = "";
  private model = "";
  private created = 0;
  private content = "";
  private tools = new Map<number, OAIToolCall>();
  private finish: OAIFinishReason = null;
  private usage: OAIUsage | undefined;

  push(ev: SSEEvent): void {
    if (ev.data === "[DONE]") {
      this.complete = !this.errored;
      return;
    }
    let chunk: OAIChatChunk & { error?: unknown };
    try {
      chunk = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (chunk.error) {
      this.errored = true;
      return;
    }
    this.id ||= chunk.id;
    this.model ||= chunk.model;
    this.created ||= chunk.created;
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.delta?.content) this.content += choice.delta.content;
    for (const tc of choice.delta?.tool_calls ?? []) {
      let call = this.tools.get(tc.index);
      if (!call) {
        call = { id: tc.id ?? "", type: "function", function: { name: "", arguments: "" } };
        this.tools.set(tc.index, call);
      }
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
  }

  result(): OAIChatCompletion {
    const toolCalls = [...this.tools.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    const message: OAIChatCompletion["choices"][number]["message"] = { role: "assistant", content: this.content || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    const out: OAIChatCompletion = {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finish, logprobs: null }],
    };
    if (this.usage) out.usage = this.usage;
    return out;
  }
}

export class AnthropicAccumulator implements Accumulator<ANTResponse> {
  complete = false;
  errored = false;
  private message: ANTResponse | undefined;
  private blocks: ANTContentBlock[] = [];
  private partialJson = new Map<number, string>();

  push(ev: SSEEvent): void {
    let data: ANTStreamEvent;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (data.type) {
      case "message_start":
        this.message = { ...data.message, content: [], usage: { ...data.message.usage } };
        break;
      case "content_block_start":
        this.blocks[data.index] = structuredClone(data.content_block);
        if (data.content_block.type === "tool_use") this.partialJson.set(data.index, "");
        break;
      case "content_block_delta": {
        const block = this.blocks[data.index] as Record<string, unknown> | undefined;
        if (!block) break;
        const d = data.delta as Record<string, string>;
        if (d.type === "text_delta") block.text = ((block.text as string) ?? "") + d.text;
        else if (d.type === "input_json_delta") this.partialJson.set(data.index, (this.partialJson.get(data.index) ?? "") + d.partial_json);
        else if (d.type === "thinking_delta") block.thinking = ((block.thinking as string) ?? "") + d.thinking;
        else if (d.type === "signature_delta") block.signature = ((block.signature as string) ?? "") + d.signature;
        break;
      }
      case "content_block_stop": {
        const json = this.partialJson.get(data.index);
        const block = this.blocks[data.index] as Record<string, unknown> | undefined;
        if (json !== undefined && block) block.input = json ? parseArgs(json) : {};
        break;
      }
      case "message_delta":
        if (this.message) {
          this.message.stop_reason = data.delta.stop_reason;
          this.message.stop_sequence = data.delta.stop_sequence ?? null;
          for (const [k, v] of Object.entries(data.usage ?? {})) {
            if (v !== undefined && v !== null) (this.message.usage as Record<string, unknown>)[k] = v;
          }
        }
        break;
      case "message_stop":
        this.complete = !this.errored;
        break;
      case "error":
        this.errored = true;
        break;
    }
  }

  result(): ANTResponse {
    if (!this.message) throw new Error("stream contained no message_start event");
    return { ...this.message, content: this.blocks.filter(Boolean) };
  }
}

/**
 * The gateway always asks OpenAI upstreams for a trailing usage chunk (it needs
 * the numbers for cost accounting). This filter removes it again for clients
 * that did not set `stream_options.include_usage`.
 */
export class HideUsageStream implements StreamTranslator {
  constructor(private readonly clientWantsUsage: boolean) {}

  push(ev: SSEEvent): SSEEvent[] {
    if (this.clientWantsUsage || ev.data === "[DONE]") return [ev];
    try {
      const chunk = JSON.parse(ev.data) as OAIChatChunk;
      if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) return [];
      if (chunk.usage) {
        delete chunk.usage;
        return [{ ...ev, data: JSON.stringify(chunk) }];
      }
    } catch {
      // forward unparseable frames untouched
    }
    return [ev];
  }

  end(): SSEEvent[] {
    return [];
  }
}

export class IdentityStream implements StreamTranslator {
  push(ev: SSEEvent): SSEEvent[] {
    return [ev];
  }
  end(): SSEEvent[] {
    return [];
  }
}
