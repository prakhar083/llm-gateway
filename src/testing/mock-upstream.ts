/**
 * A small OpenAI- and Anthropic-compatible mock LLM server. Used by the test
 * suite, the benchmark, and the docker-compose demo so the gateway can be
 * exercised end to end without provider credentials.
 *
 * Default behaviour is deterministic: it echoes the last user message, and if
 * tools are offered (and the conversation does not already end in a tool
 * result) it calls the first tool. Tests can override any reply.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeSSE, type SSEEvent } from "../sse.js";
import { antEvent } from "../translate/stream.js";

export interface RecordedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: any;
}

export interface MockReply {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body (non-streaming or error). */
  json?: unknown;
  /** Raw SSE events for a streaming reply. */
  sse?: Array<SSEEvent | string>;
  /** Delay before sending headers. */
  delayMs?: number;
  /** Never respond (for timeout tests). */
  hang?: boolean;
  /** Destroy the socket without responding (network error). */
  drop?: boolean;
}

export type MockHandler = (req: RecordedRequest) => MockReply | undefined | Promise<MockReply | undefined>;

export interface MockUpstream {
  url: string;
  requests: RecordedRequest[];
  setHandler(h: MockHandler | undefined): void;
  close(): Promise<void>;
}

export async function startMockUpstream(opts: { port?: number; host?: string; handler?: MockHandler; latencyMs?: number } = {}): Promise<MockUpstream> {
  let handler = opts.handler;
  const requests: RecordedRequest[] = [];

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = undefined;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      body = undefined;
    }
    const recorded: RecordedRequest = { path: req.url ?? "/", headers: req.headers, body };
    requests.push(recorded);

    if (req.method === "GET" && recorded.path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }

    const reply = (await handler?.(recorded)) ?? defaultReply(recorded);
    if (reply.hang) return;
    if (reply.drop) {
      req.socket.destroy();
      return;
    }
    const delay = reply.delayMs ?? opts.latencyMs ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    if (res.destroyed) return;

    if (reply.sse) {
      res.writeHead(reply.status ?? 200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...reply.headers });
      for (const ev of reply.sse) res.write(typeof ev === "string" ? ev : encodeSSE(ev));
      res.end();
      return;
    }
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.json ?? {}));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${opts.host === "0.0.0.0" ? "127.0.0.1" : (opts.host ?? "127.0.0.1")}:${port}`,
    requests,
    setHandler(h) {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function defaultReply(req: RecordedRequest): MockReply {
  if (req.path.endsWith("/chat/completions")) return openaiReply(req.body);
  if (req.path.endsWith("/messages")) return anthropicReply(req.body);
  if (req.path.endsWith("/embeddings")) return embeddingsReply(req.body);
  return { status: 404, json: { error: { message: `mock: no route for ${req.path}`, type: "not_found" } } };
}

const estimate = (s: string) => Math.max(1, Math.ceil(s.length / 4));

function lastUserText(messages: any[]): { text: string; endsWithToolResult: boolean } {
  const last = messages.at(-1);
  if (!last) return { text: "", endsWithToolResult: false };
  if (last.role === "tool") return { text: String(last.content), endsWithToolResult: true };
  if (typeof last.content === "string") return { text: last.content, endsWithToolResult: false };
  const blocks: any[] = last.content ?? [];
  const toolResult = blocks.find((b) => b.type === "tool_result");
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  if (toolResult) return { text: typeof toolResult.content === "string" ? toolResult.content : text, endsWithToolResult: true };
  return { text, endsWithToolResult: false };
}

export function openaiReply(body: any): MockReply {
  const { text, endsWithToolResult } = lastUserText(body?.messages ?? []);
  const model = body?.model ?? "mock";
  const promptTokens = estimate(JSON.stringify(body?.messages ?? []));
  const tool = !endsWithToolResult ? body?.tools?.[0]?.function?.name : undefined;
  const content = tool ? null : `echo: ${text}`;
  const args = JSON.stringify({ query: text });
  const completionTokens = estimate(content ?? args);
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  const id = "chatcmpl-mock";
  const created = 1_700_000_000;
  const toolCalls = tool ? [{ id: "call_mock_1", type: "function", function: { name: tool, arguments: args } }] : undefined;
  const finish = tool ? "tool_calls" : "stop";

  if (!body?.stream) {
    return {
      json: {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
        usage,
      },
    };
  }
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
    data: JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] }),
  });
  const sse: SSEEvent[] = [chunk({ role: "assistant", content: "" })];
  if (content) for (const piece of content.match(/\S+\s*/g) ?? []) sse.push(chunk({ content: piece }));
  if (tool) {
    sse.push(chunk({ tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: tool, arguments: "" } }] }));
    const mid = Math.floor(args.length / 2);
    sse.push(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, mid) } }] }));
    sse.push(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] }));
  }
  sse.push(chunk({}, finish));
  if (body.stream_options?.include_usage) {
    sse.push({ data: JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage }) });
  }
  sse.push({ data: "[DONE]" });
  return { sse };
}

export function anthropicReply(body: any): MockReply {
  const { text, endsWithToolResult } = lastUserText(body?.messages ?? []);
  const model = body?.model ?? "mock";
  const inputTokens = estimate(JSON.stringify(body?.messages ?? []) + JSON.stringify(body?.system ?? ""));
  const tool = !endsWithToolResult ? body?.tools?.[0]?.name : undefined;
  const input = { query: text };
  const content: any[] = tool
    ? [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_mock_1", name: tool, input }]
    : [{ type: "text", text: `echo: ${text}` }];
  const outputTokens = estimate(JSON.stringify(content));
  const stop_reason = tool ? "tool_use" : "end_turn";
  const message = { id: "msg_mock", type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };

  if (!body?.stream) return { json: message };
  const sse: SSEEvent[] = [
    antEvent({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } as any }),
    { event: "ping", data: '{"type":"ping"}' },
  ];
  content.forEach((block, index) => {
    if (block.type === "text") {
      sse.push(antEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      for (const piece of block.text.match(/\S+\s*/g) ?? []) {
        sse.push(antEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } }));
      }
    } else {
      sse.push(antEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
      const json = JSON.stringify(block.input);
      const mid = Math.floor(json.length / 2);
      sse.push(antEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, mid) } }));
      sse.push(antEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(mid) } }));
    }
    sse.push(antEvent({ type: "content_block_stop", index }));
  });
  sse.push(antEvent({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: outputTokens } }));
  sse.push(antEvent({ type: "message_stop" }));
  return { sse };
}

/** Deterministic bag-of-words embedding so semantically "close" strings share dimensions. */
function embeddingsReply(body: any): MockReply {
  const inputs: string[] = Array.isArray(body?.input) ? body.input : [String(body?.input ?? "")];
  const data = inputs.map((text, index) => {
    const v = new Array(64).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261;
      for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      v[(h >>> 0) % 64] += 1;
    }
    return { object: "embedding", index, embedding: v };
  });
  return { json: { object: "list", data, model: body?.model ?? "mock-embed", usage: { prompt_tokens: 0, total_tokens: 0 } } };
}
