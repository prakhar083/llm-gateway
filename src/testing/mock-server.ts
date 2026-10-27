#!/usr/bin/env node
/** Runs the mock upstream as a standalone server (docker-compose demo, benchmarks). */
import { startMockUpstream } from "./mock-upstream.js";

const port = Number(process.env.PORT ?? 9090);
const latencyMs = Number(process.env.MOCK_LATENCY_MS ?? 0);
const mock = await startMockUpstream({ port, host: "0.0.0.0", latencyMs });
console.log(JSON.stringify({ msg: "mock upstream listening", url: mock.url, latencyMs }));
const stop = () => void mock.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
