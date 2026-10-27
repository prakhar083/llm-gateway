/**
 * The official OpenAI SDK pointed at llm-gateway. Nothing changes except
 * baseURL and the key: `smart` is a gateway alias that resolves to Claude
 * (translated from the Chat Completions format) with a fallback chain.
 *
 *   docker compose up --build
 *   npx tsx examples/openai-sdk.ts
 */
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: process.env.GATEWAY_URL ?? "http://localhost:8080/v1",
  apiKey: process.env.GATEWAY_KEY ?? "sk-gw-demo",
});

// Non-streaming, deterministic: eligible for the cache. Run it twice and the
// second call is served from cache (x-gateway-cache: hit).
const { data, response } = await client.chat.completions
  .create({
    model: "smart",
    temperature: 0,
    messages: [
      { role: "system", content: "You are a concise assistant." },
      { role: "user", content: "What is the capital of France?" },
    ],
  })
  .withResponse();
console.log(data.choices[0]?.message.content);
console.log("cache:", response.headers.get("x-gateway-cache"), "cost:", response.headers.get("x-gateway-cost-usd"));

// Streaming with tools. The gateway turns Claude's tool_use stream into
// OpenAI tool_call deltas.
const stream = await client.chat.completions.create({
  model: "smart",
  stream: true,
  stream_options: { include_usage: true },
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Current weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ],
  messages: [{ role: "user", content: "What's the weather in Lisbon?" }],
});

let args = "";
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.content) process.stdout.write(delta.content);
  for (const call of delta?.tool_calls ?? []) {
    if (call.function?.name) console.log(`\ntool call: ${call.function.name}`);
    args += call.function?.arguments ?? "";
  }
  if (chunk.usage) console.log(`\nusage: ${JSON.stringify(chunk.usage)}`);
}
if (args) console.log("arguments:", JSON.parse(args));
