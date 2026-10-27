/**
 * The official Anthropic SDK pointed at llm-gateway. `fast` is an alias whose
 * first target is down in the demo config, so this request also shows the
 * fallback chain at work: it lands on an OpenAI-compatible upstream and the
 * response is translated back into the Messages format.
 *
 *   docker compose up --build
 *   npx tsx examples/anthropic-sdk.ts
 */
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: process.env.GATEWAY_URL ?? "http://localhost:8080",
  apiKey: process.env.GATEWAY_KEY ?? "sk-gw-demo",
});

const message = await client.messages.create({
  model: "fast",
  max_tokens: 512,
  messages: [{ role: "user", content: "Summarise the CAP theorem in one sentence." }],
});
for (const block of message.content) if (block.type === "text") console.log(block.text);
console.log("stop_reason:", message.stop_reason, "usage:", message.usage);

// Streaming against a Claude-backed alias is a straight passthrough.
const stream = client.messages.stream({
  model: "smart",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Write a haiku about load balancers." }],
});
stream.on("text", (text) => process.stdout.write(text));
const final = await stream.finalMessage();
console.log(`\n\nmodel: ${final.model}, output tokens: ${final.usage.output_tokens}`);
