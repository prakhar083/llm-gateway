import { describe, expect, it } from "vitest";
import type { ANTResponse } from "../src/formats/anthropic.js";
import type { OAIChatCompletion } from "../src/formats/openai.js";
import { encodeSSE, sseDecoderStream, SSEParser, type SSEEvent } from "../src/sse.js";
import { AnthropicAccumulator, HideUsageStream, OpenAIAccumulator } from "../src/translate/accumulate.js";
import { anthropicResponseToOpenai, openaiResponseToAnthropic } from "../src/translate/response.js";
import { antEvent, AnthropicToOpenAIStream, OpenAIToAnthropicStream, translatorStream } from "../src/translate/stream.js";
import { anthropicMessageToEvents, openaiCompletionToEvents } from "../src/translate/synthesize.js";
import { sseJson } from "./helpers.js";

const antMessage: ANTResponse = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "Checking both cities." },
    { type: "tool_use", id: "toolu_a", name: "get_weather", input: { city: "Paris" } },
    { type: "tool_use", id: "toolu_b", name: "get_weather", input: { city: "Rome", units: "c" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
};

/** A realistic Anthropic stream for `antMessage`, with tool JSON split mid-token. */
function anthropicStream(): SSEEvent[] {
  return [
    antEvent({ type: "message_start", message: { ...antMessage, content: [], stop_reason: null, usage: { ...antMessage.usage, output_tokens: 1 } } }),
    { event: "ping", data: '{"type":"ping"}' },
    antEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    antEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
    antEvent({ type: "content_block_stop", index: 0 }),
    antEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    antEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking " } }),
    antEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "both cities." } }),
    antEvent({ type: "content_block_stop", index: 1 }),
    antEvent({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_a", name: "get_weather", input: {} } }),
    antEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "" } }),
    antEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city": "Pa' } }),
    antEvent({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'ris"}' } }),
    antEvent({ type: "content_block_stop", index: 2 }),
    antEvent({ type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_b", name: "get_weather", input: {} } }),
    antEvent({ type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: '{"city":"Rome","units":"c"}' } }),
    antEvent({ type: "content_block_stop", index: 3 }),
    antEvent({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } }),
    antEvent({ type: "message_stop" }),
  ];
}

function run(t: { push(e: SSEEvent): SSEEvent[]; end(): SSEEvent[] }, events: SSEEvent[]): SSEEvent[] {
  return [...events.flatMap((e) => t.push(e)), ...t.end()];
}

describe("non-streaming response translation", () => {
  it("Anthropic -> OpenAI: text, tool calls, stop reason and cache-aware usage", () => {
    const out = anthropicResponseToOpenai(antMessage, 1234);
    expect(out).toEqual({
      id: "chatcmpl-msg_01",
      object: "chat.completion",
      created: 1234,
      model: "claude-sonnet-5-5",
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Checking both cities.",
            tool_calls: [
              { id: "toolu_a", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              { id: "toolu_b", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome","units":"c"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 125, completion_tokens: 40, total_tokens: 165, prompt_tokens_details: { cached_tokens: 20 } },
    });
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["refusal", "content_filter"],
  ] as const)("maps stop_reason %s -> %s", (stop, finish) => {
    expect(anthropicResponseToOpenai({ ...antMessage, content: [], stop_reason: stop }).choices[0]!.finish_reason).toBe(finish);
  });

  it("OpenAI -> Anthropic: content, tool calls (including malformed arguments) and usage", () => {
    const completion: OAIChatCompletion = {
      id: "chatcmpl-9",
      object: "chat.completion",
      created: 1,
      model: "gpt-x",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "On it.",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
              { id: "call_2", type: "function", function: { name: "g", arguments: "{not json" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57, prompt_tokens_details: { cached_tokens: 10 } },
    };
    expect(openaiResponseToAnthropic(completion)).toEqual({
      id: "msg_chatcmpl-9",
      type: "message",
      role: "assistant",
      model: "gpt-x",
      content: [
        { type: "text", text: "On it." },
        { type: "tool_use", id: "call_1", name: "f", input: { a: 1 } },
        { type: "tool_use", id: "call_2", name: "g", input: { _raw_arguments: "{not json" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 40, output_tokens: 7, cache_read_input_tokens: 10 },
    });
  });
});

describe("Anthropic stream -> OpenAI stream", () => {
  it("emits role, text, indexed tool-call deltas, finish, usage and [DONE]", () => {
    const out = run(new AnthropicToOpenAIStream(true, 99), anthropicStream());
    expect(out.at(-1)!.data).toBe("[DONE]");
    const chunks = sseJson(out);
    expect(chunks.every((c) => c.id === "chatcmpl-msg_01" && c.object === "chat.completion.chunk" && c.created === 99)).toBe(true);
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });

    const toolDeltas = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []);
    expect(toolDeltas).toEqual([
      { index: 0, id: "toolu_a", type: "function", function: { name: "get_weather", arguments: "" } },
      { index: 0, function: { arguments: '{"city": "Pa' } },
      { index: 0, function: { arguments: 'ris"}' } },
      { index: 1, id: "toolu_b", type: "function", function: { name: "get_weather", arguments: "" } },
      { index: 1, function: { arguments: '{"city":"Rome","units":"c"}' } },
    ]);
    const finish = chunks.find((c) => c.choices[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("tool_calls");
    const usage = chunks.at(-1);
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toEqual({ prompt_tokens: 125, completion_tokens: 40, total_tokens: 165, prompt_tokens_details: { cached_tokens: 20 } });
  });

  it("accumulates to the same result as the non-streaming translation", () => {
    const acc = new OpenAIAccumulator();
    for (const ev of run(new AnthropicToOpenAIStream(true, 1234), anthropicStream())) acc.push(ev);
    expect(acc.complete).toBe(true);
    const expected = anthropicResponseToOpenai(antMessage, 1234);
    // tool-call arguments are the model's raw JSON text, so compare parsed values
    const got = acc.result();
    expect(got.choices[0]!.message.content).toBe(expected.choices[0]!.message.content);
    expect(got.choices[0]!.message.tool_calls!.map((t) => [t.id, t.function.name, JSON.parse(t.function.arguments)])).toEqual(
      expected.choices[0]!.message.tool_calls!.map((t) => [t.id, t.function.name, JSON.parse(t.function.arguments)]),
    );
    expect(got.usage).toEqual(expected.usage);
    expect(got.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("survives arbitrary network chunk boundaries and CRLF line endings", async () => {
    const wire = anthropicStream().map(encodeSSE).join("").replaceAll("\n", "\r\n");
    const bytes = new TextEncoder().encode(wire);
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const acc = new OpenAIAccumulator();
    const reader = source.pipeThrough(sseDecoderStream()).pipeThrough(translatorStream(new AnthropicToOpenAIStream(true))).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      acc.push(value);
    }
    expect(acc.complete).toBe(true);
    expect(acc.result().choices[0]!.message.content).toBe("Checking both cities.");
    expect(acc.result().choices[0]!.message.tool_calls).toHaveLength(2);
  });

  it("forwards upstream error events in OpenAI shape", () => {
    const out = run(new AnthropicToOpenAIStream(false), [
      antEvent({ type: "message_start", message: { ...antMessage, content: [] } }),
      antEvent({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
    ]);
    expect(sseJson(out).at(-1)).toEqual({ error: { message: "Overloaded", type: "overloaded_error" } });
    expect(out.at(-1)!.data).toBe("[DONE]");
  });

  it("reports a truncated upstream stream as an error instead of a clean finish", () => {
    const events = anthropicStream().slice(0, 8);
    const out = run(new AnthropicToOpenAIStream(false), events);
    expect(sseJson(out).at(-1).error.message).toMatch(/ended unexpectedly/);
  });
});

describe("OpenAI stream -> Anthropic stream", () => {
  const id = "chatcmpl-x";
  const chunk = (delta: unknown, finish: string | null = null): SSEEvent => ({
    data: JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "llama", choices: [{ index: 0, delta, finish_reason: finish }] }),
  });
  const openaiStream: SSEEvent[] = [
    chunk({ role: "assistant", content: "" }),
    chunk({ content: "Let me " }),
    chunk({ content: "check." }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "lookup", arguments: '{"q":"y"}' } }] }),
    chunk({}, "tool_calls"),
    { data: JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "llama", choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }) },
    { data: "[DONE]" },
  ];

  it("produces a well-formed Anthropic event sequence", () => {
    const out = run(new OpenAIToAnthropicStream(), openaiStream);
    expect(out.every((e) => e.event === JSON.parse(e.data).type)).toBe(true);
    expect(out.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const delta = JSON.parse(out.at(-2)!.data);
    expect(delta).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 30, output_tokens: 12 },
    });
  });

  it("accumulates into the equivalent Anthropic message", () => {
    const acc = new AnthropicAccumulator();
    for (const ev of run(new OpenAIToAnthropicStream(), openaiStream)) acc.push(ev);
    expect(acc.complete).toBe(true);
    expect(acc.result()).toEqual({
      id: "msg_chatcmpl-x",
      type: "message",
      role: "assistant",
      model: "llama",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } },
        { type: "tool_use", id: "call_2", name: "lookup", input: { q: "y" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 12 },
    });
  });

  it("maps an upstream error chunk to an Anthropic error event", () => {
    const out = run(new OpenAIToAnthropicStream(), [chunk({ content: "a" }), { data: '{"error":{"message":"rate limited","type":"rate_limit_error"}}' }]);
    expect(JSON.parse(out.at(-1)!.data)).toEqual({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } });
  });
});

describe("stream synthesis (cache replay)", () => {
  it("round-trips an Anthropic message through events and the accumulator", () => {
    const acc = new AnthropicAccumulator();
    for (const ev of anthropicMessageToEvents(antMessage)) acc.push(ev);
    expect(acc.result()).toEqual(antMessage);
  });

  it("round-trips an OpenAI completion through chunks and the accumulator", () => {
    const completion = anthropicResponseToOpenai(antMessage, 5);
    const acc = new OpenAIAccumulator();
    for (const ev of openaiCompletionToEvents(completion, true)) acc.push(ev);
    expect(acc.result()).toEqual(completion);
  });

  it("hides the usage chunk from clients that did not request it", () => {
    const events = openaiCompletionToEvents(anthropicResponseToOpenai(antMessage), true);
    const filter = new HideUsageStream(false);
    const shown = events.flatMap((e) => filter.push(e));
    expect(sseJson(shown).some((c) => c.usage)).toBe(false);
    expect(shown.at(-1)!.data).toBe("[DONE]");
  });
});

describe("SSE parser", () => {
  it("handles multi-line data, comments, and events without a trailing blank line", () => {
    const p = new SSEParser();
    const evs = [...p.push(": keep-alive\n\nevent: a\ndata: 1\ndata: 2\n\ndata: tail"), ...p.end()];
    expect(evs).toEqual([{ event: "a", data: "1\n2" }, { data: "tail" }]);
  });
});
