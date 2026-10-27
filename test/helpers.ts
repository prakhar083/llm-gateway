import { parseConfig } from "../src/config/load.js";
import type { GatewayConfig } from "../src/config/schema.js";
import { SSEParser, type SSEEvent } from "../src/sse.js";

/** Build a config from YAML with `{{openai}}` / `{{anthropic}}` placeholders for mock base URLs. */
export function configFrom(yaml: string, urls: { openai?: string; anthropic?: string } = {}, env: NodeJS.ProcessEnv = {}): GatewayConfig {
  const text = yaml.replaceAll("{{openai}}", `${urls.openai ?? "http://127.0.0.1:1"}/v1`).replaceAll("{{anthropic}}", urls.anthropic ?? "http://127.0.0.1:1");
  return parseConfig(text, env);
}

export async function readSSE(res: Response): Promise<SSEEvent[]> {
  const text = await res.text();
  const parser = new SSEParser();
  return [...parser.push(text), ...parser.end()];
}

export function sseJson(events: SSEEvent[]): any[] {
  return events.filter((e) => e.data !== "[DONE]").map((e) => JSON.parse(e.data));
}

export function rawSSE(text: string): SSEEvent[] {
  const p = new SSEParser();
  return [...p.push(text), ...p.end()];
}

export function post(app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** Serve a Hono app on an ephemeral port (for clients that need a real URL, like the official SDKs). */
export async function listen(app: { fetch: (req: Request) => Response | Promise<Response> }): Promise<{ url: string; close(): Promise<void> }> {
  const { serve } = await import("@hono/node-server");
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export async function json(res: Response): Promise<any> {
  return res.json();
}
