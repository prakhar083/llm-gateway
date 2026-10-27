import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors.js";
import type { ANTRequest } from "../src/formats/anthropic.js";
import type { OAIChatRequest } from "../src/formats/openai.js";
import { anthropicToOpenaiRequest, openaiToAnthropicRequest } from "../src/translate/request.js";

const toAnt = { defaultMaxTokens: 1024, forwardSamplingParams: false };

describe("OpenAI -> Anthropic request", () => {
  it("hoists system/developer messages and fills max_tokens", () => {
    const out = openaiToAnthropicRequest(
      {
        model: "smart",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "developer", content: [{ type: "text", text: "Answer in English." }] },
          { role: "user", content: "hi" },
        ],
      },
      "claude-sonnet-5-5",
      toAnt,
    );
    expect(out).toEqual({
      model: "claude-sonnet-5-5",
      system: "You are terse.\n\nAnswer in English.",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
  });

  it("prefers max_completion_tokens, maps stop and user", () => {
    const out = openaiToAnthropicRequest(
      { model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 10, max_completion_tokens: 20, stop: "END", user: "u-1" },
      "claude-haiku-5-5",
      toAnt,
    );
    expect(out.max_tokens).toBe(20);
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.metadata).toEqual({ user_id: "u-1" });
  });

  it("drops sampling params by default and clamps temperature when forwarding", () => {
    const req: OAIChatRequest = { model: "m", messages: [{ role: "user", content: "x" }], temperature: 1.6, top_p: 0.9 };
    const dropped = openaiToAnthropicRequest(req, "c", toAnt);
    expect(dropped.temperature).toBeUndefined();
    expect(dropped.top_p).toBeUndefined();
    const forwarded = openaiToAnthropicRequest(req, "c", { ...toAnt, forwardSamplingParams: true });
    expect(forwarded.temperature).toBe(1);
    expect(forwarded.top_p).toBe(0.9);
  });

  it("translates a full tool-calling round trip, merging parallel tool results into one user turn", () => {
    const out = openaiToAnthropicRequest(
      {
        model: "m",
        messages: [
          { role: "user", content: "Weather in Paris and Rome?" },
          {
            role: "assistant",
            content: "Checking both.",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              { id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"Rome"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "18C" },
          { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "24C" }] },
          { role: "user", content: "Which is warmer?" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Current weather",
              parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              strict: true,
            },
          },
        ],
        tool_choice: "required",
        parallel_tool_calls: false,
      },
      "claude-opus-5-5",
      toAnt,
    );
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Weather in Paris and Rome?" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking both." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "call_2", name: "get_weather", input: { city: "Rome" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "18C" },
          { type: "tool_result", tool_use_id: "call_2", content: "24C" },
          { type: "text", text: "Which is warmer?" },
        ],
      },
    ]);
    expect(out.tools).toEqual([
      {
        name: "get_weather",
        description: "Current weather",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        strict: true,
      },
    ]);
    expect(out.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });
  });

  it.each([
    ["auto", { type: "auto" }],
    ["none", { type: "none" }],
    [{ type: "function", function: { name: "f" } }, { type: "tool", name: "f" }],
  ] as const)("maps tool_choice %j", (choice, expected) => {
    const out = openaiToAnthropicRequest(
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: choice as OAIChatRequest["tool_choice"],
      },
      "c",
      toAnt,
    );
    expect(out.tool_choice).toEqual(expected);
    expect(out.tools![0]!.input_schema).toEqual({ type: "object", properties: {} });
  });

  it("converts data-URL and remote images", () => {
    const out = openaiToAnthropicRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare" },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
              { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
            ],
          },
        ],
      },
      "c",
      toAnt,
    );
    expect(out.messages[0]!.content).toEqual([
      { type: "text", text: "Compare" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "image", source: { type: "url", url: "https://example.com/cat.jpg" } },
    ]);
  });

  it("maps json_schema response_format to output_config", () => {
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const out = openaiToAnthropicRequest(
      { model: "m", messages: [{ role: "user", content: "x" }], response_format: { type: "json_schema", json_schema: { name: "r", schema } } },
      "c",
      toAnt,
    );
    expect(out.output_config).toEqual({ format: { type: "json_schema", schema } });
  });

  it("rejects requests it cannot translate faithfully", () => {
    const bad = (req: Partial<OAIChatRequest>) => () =>
      openaiToAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }], ...req } as OAIChatRequest, "c", toAnt);
    expect(bad({ n: 2 })).toThrow(GatewayError);
    expect(
      bad({
        messages: [
          { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{oops" } }] },
        ],
      }),
    ).toThrow(/not valid JSON/);
    expect(bad({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] })).toThrow(/input_audio/);
  });
});

describe("Anthropic -> OpenAI request", () => {
  const toOai = { maxTokensField: "max_tokens" as const };

  it("translates system, tool use and tool results (tool messages precede trailing user text)", () => {
    const req: ANTRequest = {
      model: "fast",
      max_tokens: 256,
      system: [{ type: "text", text: "Be brief." }],
      stop_sequences: ["\n\n"],
      metadata: { user_id: "u-7" },
      stream: true,
      top_k: 5,
      messages: [
        { role: "user", content: "Weather in Oslo?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "...", signature: "sig" },
            { type: "text", text: "Looking it up." },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Oslo" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "-3C" }] },
            { type: "text", text: "Thanks" },
          ],
        },
      ],
      tools: [{ name: "get_weather", description: "Weather", input_schema: { type: "object", properties: { city: { type: "string" } } } }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    };
    const out = anthropicToOpenaiRequest(req, "llama-3.3-70b", toOai);
    expect(out).toEqual({
      model: "llama-3.3-70b",
      max_tokens: 256,
      stream: true,
      stream_options: { include_usage: true },
      stop: ["\n\n"],
      user: "u-7",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Weather in Oslo?" },
        {
          role: "assistant",
          content: "Looking it up.",
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "-3C" },
        { role: "user", content: "Thanks" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
  });

  it("marks errored tool results and maps images to data URLs", () => {
    const out = anthropicToOpenaiRequest(
      {
        model: "m",
        max_tokens: 5,
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t", content: "boom", is_error: true },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
              { type: "text", text: "what is this" },
            ],
          },
        ],
      },
      "gpt",
      { maxTokensField: "max_completion_tokens" },
    );
    expect(out.max_completion_tokens).toBe(5);
    expect(out.messages).toEqual([
      { role: "tool", tool_call_id: "t", content: "Error: boom" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
          { type: "text", text: "what is this" },
        ],
      },
    ]);
  });

  it.each([
    [{ type: "any" }, "required"],
    [{ type: "none" }, "none"],
    [{ type: "tool", name: "f" }, { type: "function", function: { name: "f" } }],
  ] as const)("maps tool_choice %j", (choice, expected) => {
    const out = anthropicToOpenaiRequest(
      { model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }], tools: [{ name: "f", input_schema: {} }], tool_choice: choice as ANTRequest["tool_choice"] },
      "g",
      toOai,
    );
    expect(out.tool_choice).toEqual(expected);
  });

  it("refuses Anthropic server tools", () => {
    expect(() =>
      anthropicToOpenaiRequest(
        { model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }], tools: [{ type: "web_search_20260209", name: "web_search", input_schema: {} }] },
        "g",
        toOai,
      ),
    ).toThrow(/server tool/);
  });
});
