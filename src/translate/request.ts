import type {
  ANTContentBlock,
  ANTImageBlock,
  ANTMessage,
  ANTRequest,
  ANTTextBlock,
  ANTTool,
  ANTToolChoice,
  ANTToolResultBlock,
} from "../formats/anthropic.js";
import {
  oaiContentText,
  type OAIChatRequest,
  type OAIContentPart,
  type OAIMessage,
  type OAITool,
  type OAIToolCall,
  type OAIToolChoice,
} from "../formats/openai.js";
import { GatewayError } from "../errors.js";

export interface ToAnthropicOptions {
  defaultMaxTokens: number;
  forwardSamplingParams: boolean;
}

/** OpenAI Chat Completions request -> Anthropic Messages request. */
export function openaiToAnthropicRequest(req: OAIChatRequest, model: string, opts: ToAnthropicOptions): ANTRequest {
  if (req.n != null && req.n > 1) {
    throw new GatewayError("invalid_request", "n > 1 is not supported when routing to an Anthropic upstream");
  }

  const system: string[] = [];
  const messages: ANTMessage[] = [];
  const push = (role: "user" | "assistant", blocks: ANTContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = messages.at(-1);
    // Anthropic requires alternating roles; consecutive same-role turns are merged.
    if (last && last.role === role) (last.content as ANTContentBlock[]).push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of req.messages as OAIMessage[]) {
    switch (m.role) {
      case "system":
      case "developer": {
        const text = oaiContentText(m.content);
        if (text) system.push(text);
        break;
      }
      case "user":
        push("user", userBlocks(m.content));
        break;
      case "assistant": {
        const blocks: ANTContentBlock[] = [];
        const text = oaiContentText(m.content ?? null);
        if (text) blocks.push({ type: "text", text });
        for (const call of m.tool_calls ?? []) blocks.push(toolUseBlock(call));
        push("assistant", blocks);
        break;
      }
      case "tool": {
        const result: ANTToolResultBlock = {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: oaiContentText(m.content),
        };
        push("user", [result]);
        break;
      }
      default:
        throw new GatewayError("invalid_request", `unsupported message role "${(m as { role: string }).role}"`);
    }
  }

  const out: ANTRequest = {
    model,
    messages,
    max_tokens: req.max_completion_tokens ?? req.max_tokens ?? opts.defaultMaxTokens,
  };
  if (system.length > 0) out.system = system.join("\n\n");
  if (req.stream) out.stream = true;
  if (req.stop != null) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.user) out.metadata = { user_id: req.user };
  if (opts.forwardSamplingParams) {
    // OpenAI accepts temperature in [0, 2]; Anthropic in [0, 1].
    if (req.temperature != null) out.temperature = Math.min(req.temperature, 1);
    if (req.top_p != null) out.top_p = req.top_p;
  }

  if (req.tools?.length) {
    out.tools = req.tools.map(toolToAnthropic);
    const choice = toolChoiceToAnthropic(req.tool_choice, req.parallel_tool_calls);
    if (choice) out.tool_choice = choice;
  }

  if (req.response_format?.type === "json_schema" && req.response_format.json_schema?.schema) {
    out.output_config = { format: { type: "json_schema", schema: req.response_format.json_schema.schema } };
  }
  return out;
}

function userBlocks(content: string | OAIContentPart[]): ANTContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.map((part): ANTContentBlock => {
    if (part.type === "text") return { type: "text", text: (part as { text: string }).text };
    if (part.type === "image_url") return imageBlock((part as { image_url: { url: string } }).image_url.url);
    throw new GatewayError("invalid_request", `content part type "${part.type}" cannot be translated to Anthropic`);
  });
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function imageBlock(url: string): ANTImageBlock {
  const m = DATA_URL.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } };
  return { type: "image", source: { type: "url", url } };
}

function toolUseBlock(call: OAIToolCall): ANTContentBlock {
  let input: unknown = {};
  if (call.function.arguments) {
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      throw new GatewayError(
        "invalid_request",
        `tool call ${call.id} has arguments that are not valid JSON; Anthropic requires a JSON object`,
      );
    }
  }
  return { type: "tool_use", id: call.id, name: call.function.name, input };
}

function toolToAnthropic(t: OAITool): ANTTool {
  if (t.type !== "function") {
    throw new GatewayError("invalid_request", `tool type "${t.type}" cannot be translated to Anthropic`);
  }
  const tool: ANTTool = {
    name: t.function.name,
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  };
  if (t.function.description) tool.description = t.function.description;
  if (t.function.strict) tool.strict = true;
  return tool;
}

function toolChoiceToAnthropic(choice: OAIToolChoice | undefined, parallel: boolean | undefined): ANTToolChoice | undefined {
  const disable = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === undefined) return parallel === false ? { type: "auto", ...disable } : undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "auto") return { type: "auto", ...disable };
  if (choice === "required") return { type: "any", ...disable };
  return { type: "tool", name: choice.function.name, ...disable };
}

export interface ToOpenAIOptions {
  maxTokensField: "max_tokens" | "max_completion_tokens";
}

/** Anthropic Messages request -> OpenAI Chat Completions request. */
export function anthropicToOpenaiRequest(req: ANTRequest, model: string, opts: ToOpenAIOptions): OAIChatRequest {
  const messages: OAIMessage[] = [];
  const systemText = typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n\n");
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const m of req.messages) {
    const blocks: ANTContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "assistant") {
      const text = blocks
        .filter((b): b is ANTTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls: OAIToolCall[] = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const u = b as { id: string; name: string; input: unknown };
          return { id: u.id, type: "function", function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } };
        });
      // thinking / redacted_thinking blocks have no OpenAI equivalent and are dropped.
      const msg: OAIMessage = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (text || toolCalls.length) messages.push(msg);
      continue;
    }

    // user turn: tool results become `tool` messages, which must directly follow the assistant turn.
    const parts: OAIContentPart[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const r = b as ANTToolResultBlock;
        const content =
          typeof r.content === "string"
            ? r.content
            : (r.content ?? []).map((c) => {
                if (c.type !== "text") {
                  throw new GatewayError("invalid_request", "image content inside tool_result cannot be translated to OpenAI");
                }
                return c.text;
              }).join("");
        messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.is_error ? `Error: ${content}` : content });
      } else if (b.type === "text") {
        parts.push({ type: "text", text: (b as ANTTextBlock).text });
      } else if (b.type === "image") {
        const src = (b as ANTImageBlock).source;
        const url = src.type === "base64" ? `data:${src.media_type};base64,${src.data}` : src.url;
        parts.push({ type: "image_url", image_url: { url } });
      } else {
        throw new GatewayError("invalid_request", `content block type "${b.type}" cannot be translated to OpenAI`);
      }
    }
    if (parts.length) {
      const textOnly = parts.every((p) => p.type === "text");
      // Plain strings are the most widely supported shape across OpenAI-compatible servers.
      messages.push({ role: "user", content: textOnly ? parts.map((p) => (p as { text: string }).text).join("\n") : parts });
    }
  }

  const out: OAIChatRequest = { model, messages };
  out[opts.maxTokensField] = req.max_tokens;
  if (req.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.metadata?.user_id) out.user = req.metadata.user_id;

  if (req.tools?.length) {
    out.tools = req.tools.map((t): OAITool => {
      if (t.type && t.type !== "custom") {
        throw new GatewayError("invalid_request", `server tool "${t.type}" is only available on Anthropic upstreams`);
      }
      const fn: OAITool["function"] = { name: t.name, parameters: t.input_schema };
      if (t.description) fn.description = t.description;
      return { type: "function", function: fn };
    });
    const tc = req.tool_choice;
    if (tc) {
      if (tc.type === "none") out.tool_choice = "none";
      else if (tc.type === "auto") out.tool_choice = "auto";
      else if (tc.type === "any") out.tool_choice = "required";
      else out.tool_choice = { type: "function", function: { name: tc.name } };
      if ("disable_parallel_tool_use" in tc && tc.disable_parallel_tool_use) out.parallel_tool_calls = false;
    }
  }
  return out;
}
