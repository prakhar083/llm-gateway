import type { ANTStreamEvent, ANTUsage } from "../formats/anthropic.js";
import type { OAIChatChunk, OAIChunkToolCallDelta, OAIFinishReason, OAIUsage } from "../formats/openai.js";
import type { SSEEvent } from "../sse.js";
import {
  anthropicStopToOpenai,
  anthropicUsageToOpenai,
  openaiFinishToAnthropic,
  openaiUsageToAnthropic,
} from "./response.js";
import type { ANTStopReason } from "../formats/anthropic.js";

/** A stateful SSE-to-SSE rewriter. `end()` is called once when the upstream stream closes. */
export interface StreamTranslator {
  push(ev: SSEEvent): SSEEvent[];
  end(): SSEEvent[];
}

export function translatorStream(t: StreamTranslator): TransformStream<SSEEvent, SSEEvent> {
  return new TransformStream({
    transform(ev, controller) {
      for (const out of t.push(ev)) controller.enqueue(out);
    },
    flush(controller) {
      for (const out of t.end()) controller.enqueue(out);
    },
  });
}

const DONE: SSEEvent = { data: "[DONE]" };

/** Anthropic Messages stream -> OpenAI chat.completion.chunk stream. */
export class AnthropicToOpenAIStream implements StreamTranslator {
  private id = "chatcmpl-gateway";
  private model = "";
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;
  private usage: Partial<ANTUsage> = {};
  private finish: OAIFinishReason = null;
  private sawFinish = false;
  private done = false;

  constructor(
    private readonly includeUsage: boolean,
    private readonly created = Math.floor(Date.now() / 1000),
  ) {}

  push(ev: SSEEvent): SSEEvent[] {
    if (this.done) return [];
    let data: ANTStreamEvent;
    try {
      data = JSON.parse(ev.data) as ANTStreamEvent;
    } catch {
      return [];
    }
    switch (data.type) {
      case "message_start":
        this.id = `chatcmpl-${data.message.id}`;
        this.model = data.message.model;
        this.usage = { ...data.message.usage };
        return [this.chunk({ role: "assistant", content: "" })];
      case "content_block_start": {
        const block = data.content_block;
        if (block.type === "tool_use") {
          const index = this.nextToolIndex++;
          this.toolIndexByBlock.set(data.index, index);
          const b = block as { id: string; name: string };
          return [this.chunk({ tool_calls: [{ index, id: b.id, type: "function", function: { name: b.name, arguments: "" } }] })];
        }
        if (block.type === "text" && (block as { text: string }).text) {
          return [this.chunk({ content: (block as { text: string }).text })];
        }
        return [];
      }
      case "content_block_delta": {
        const d = data.delta;
        if (d.type === "text_delta") return [this.chunk({ content: (d as { text: string }).text })];
        if (d.type === "input_json_delta") {
          const index = this.toolIndexByBlock.get(data.index);
          const partial = (d as { partial_json: string }).partial_json;
          if (index === undefined || !partial) return [];
          return [this.chunk({ tool_calls: [{ index, function: { arguments: partial } }] })];
        }
        return []; // thinking / signature deltas have no Chat Completions equivalent
      }
      case "message_delta":
        this.finish = anthropicStopToOpenai(data.delta.stop_reason);
        this.sawFinish = true;
        this.usage = { ...this.usage, ...definedOnly(data.usage ?? {}) };
        return [this.chunk({}, this.finish)];
      case "message_stop":
        return this.complete();
      case "error":
        this.done = true;
        return [{ data: JSON.stringify({ error: { message: data.error.message, type: data.error.type } }) }, DONE];
      default:
        return [];
    }
  }

  end(): SSEEvent[] {
    if (this.done) return [];
    if (this.sawFinish) return this.complete();
    this.done = true;
    return [{ data: JSON.stringify({ error: { message: "upstream stream ended unexpectedly", type: "api_error" } }) }, DONE];
  }

  /** Usage as reported so far, in OpenAI shape. */
  get openaiUsage(): OAIUsage {
    return anthropicUsageToOpenai(this.usage);
  }

  private complete(): SSEEvent[] {
    this.done = true;
    const out: SSEEvent[] = [];
    if (this.includeUsage) {
      const chunk: OAIChatChunk = { ...this.base(), choices: [], usage: this.openaiUsage };
      out.push({ data: JSON.stringify(chunk) });
    }
    out.push(DONE);
    return out;
  }

  private base() {
    return { id: this.id, object: "chat.completion.chunk" as const, created: this.created, model: this.model };
  }

  private chunk(delta: OAIChatChunk["choices"][number]["delta"], finish: OAIFinishReason = null): SSEEvent {
    const chunk: OAIChatChunk = { ...this.base(), choices: [{ index: 0, delta, finish_reason: finish }] };
    return { data: JSON.stringify(chunk) };
  }
}

/** OpenAI chat.completion.chunk stream -> Anthropic Messages stream. */
export class OpenAIToAnthropicStream implements StreamTranslator {
  private started = false;
  private done = false;
  private nextBlock = 0;
  private open: { index: number; kind: "text" | "tool" } | undefined;
  private blockByToolIndex = new Map<number, number>();
  private stopReason: ANTStopReason = null;
  private usage: OAIUsage | undefined;

  push(ev: SSEEvent): SSEEvent[] {
    if (this.done) return [];
    if (ev.data === "[DONE]") return this.finish();
    let chunk: OAIChatChunk & { error?: { message?: string; type?: string } };
    try {
      chunk = JSON.parse(ev.data);
    } catch {
      return [];
    }
    if (chunk.error) {
      this.done = true;
      return [antEvent({ type: "error", error: { type: chunk.error.type ?? "api_error", message: chunk.error.message ?? "upstream error" } })];
    }

    const out: SSEEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push(
        antEvent({
          type: "message_start",
          message: {
            id: chunk.id?.startsWith("msg_") ? chunk.id : `msg_${chunk.id ?? "gateway"}`,
            type: "message",
            role: "assistant",
            model: chunk.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }
    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    if (delta.content) {
      if (this.open?.kind !== "text") {
        out.push(...this.closeOpen());
        const index = this.nextBlock++;
        this.open = { index, kind: "text" };
        out.push(antEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      }
      out.push(antEvent({ type: "content_block_delta", index: this.open.index, delta: { type: "text_delta", text: delta.content } }));
    }

    for (const tc of delta.tool_calls ?? []) out.push(...this.toolDelta(tc));

    if (choice.finish_reason) {
      this.stopReason = openaiFinishToAnthropic(choice.finish_reason);
      out.push(...this.closeOpen());
    }
    return out;
  }

  end(): SSEEvent[] {
    if (this.done) return [];
    if (this.started && this.stopReason !== null) return this.finish();
    this.done = true;
    return [antEvent({ type: "error", error: { type: "api_error", message: "upstream stream ended unexpectedly" } })];
  }

  private toolDelta(tc: OAIChunkToolCallDelta): SSEEvent[] {
    const out: SSEEvent[] = [];
    let index = this.blockByToolIndex.get(tc.index);
    if (index === undefined) {
      out.push(...this.closeOpen());
      index = this.nextBlock++;
      this.blockByToolIndex.set(tc.index, index);
      this.open = { index, kind: "tool" };
      out.push(
        antEvent({
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: tc.id ?? `toolu_gw_${index}`, name: tc.function?.name ?? "", input: {} },
        }),
      );
    }
    const args = tc.function?.arguments;
    if (args) out.push(antEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } }));
    return out;
  }

  private closeOpen(): SSEEvent[] {
    if (!this.open) return [];
    const ev = antEvent({ type: "content_block_stop", index: this.open.index });
    this.open = undefined;
    return [ev];
  }

  private finish(): SSEEvent[] {
    this.done = true;
    const out = this.closeOpen();
    const usage = openaiUsageToAnthropic(this.usage);
    out.push(
      antEvent({
        type: "message_delta",
        delta: { stop_reason: this.stopReason ?? "end_turn", stop_sequence: null },
        usage,
      }),
      antEvent({ type: "message_stop" }),
    );
    return out;
  }
}

export function antEvent(ev: ANTStreamEvent): SSEEvent {
  return { event: ev.type, data: JSON.stringify(ev) };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}
