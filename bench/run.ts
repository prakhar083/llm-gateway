/**
 * Measures gateway overhead against the bundled mock upstream (0 ms simulated
 * latency), so the numbers isolate the proxy itself: parsing, routing,
 * translation, SSE re-encoding, metrics and cache lookups. Real LLM calls take
 * hundreds of milliseconds to minutes; this is the cost the gateway adds.
 *
 *   npm run build && npx tsx bench/run.ts
 */
import autocannon from "autocannon";
import { spawn, type ChildProcess } from "node:child_process";
import { cpus } from "node:os";

const MOCK = "http://127.0.0.1:18282";
const GATEWAY = "http://127.0.0.1:18181";
const DURATION = Number(process.env.BENCH_DURATION ?? 10);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 32);

function start(args: string[], env: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: "ignore" });
}

async function waitFor(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

const chat = (model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ model, messages: [{ role: "user", content: "Benchmark prompt: explain backpressure in two sentences." }], ...extra });

const scenarios = [
  { name: "mock upstream direct (baseline)", url: `${MOCK}/v1/chat/completions`, body: chat("gpt-bench") },
  { name: "gateway, OpenAI -> OpenAI passthrough", url: `${GATEWAY}/v1/chat/completions`, body: chat("passthrough") },
  { name: "gateway, OpenAI -> Anthropic translated", url: `${GATEWAY}/v1/chat/completions`, body: chat("translated") },
  { name: "gateway, translated + streaming (SSE)", url: `${GATEWAY}/v1/chat/completions`, body: chat("translated", { stream: true }) },
  { name: "gateway, exact cache hit", url: `${GATEWAY}/v1/chat/completions`, body: chat("translated", { temperature: 0 }) },
];

const mock = start(["dist/testing/mock-server.js"], { PORT: "18282" });
const gateway = start(["dist/index.js", "--config", "bench/gateway.bench.yaml"], { LOG_LEVEL: "warn" });
try {
  await waitFor(`${MOCK}/healthz`);
  await waitFor(`${GATEWAY}/healthz`);
  console.log(`node ${process.version}, ${cpus()[0]?.model ?? "unknown cpu"} x${cpus().length}, ${CONNECTIONS} connections, ${DURATION}s per scenario\n`);
  console.log("| scenario | req/s | mean ms | p99 ms |");
  console.log("|---|---:|---:|---:|");
  for (const s of scenarios) {
    const opts = { url: s.url, method: "POST" as const, body: s.body, headers: { "content-type": "application/json" }, connections: CONNECTIONS };
    await autocannon({ ...opts, duration: 2 }); // warm-up (also primes the cache scenario)
    const r = await autocannon({ ...opts, duration: DURATION });
    if (r.non2xx > 0 || r.errors > 0) throw new Error(`${s.name}: ${r.non2xx} non-2xx, ${r.errors} errors`);
    console.log(`| ${s.name} | ${Math.round(r.requests.average).toLocaleString("en-US")} | ${r.latency.average.toFixed(2)} | ${r.latency.p99} |`);
  }
} finally {
  mock.kill();
  gateway.kill();
}
