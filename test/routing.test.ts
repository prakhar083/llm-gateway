import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors.js";
import { routeRequest } from "../src/routing/router.js";
import { estimatePromptTokens } from "../src/routing/tokens.js";
import { configFrom } from "./helpers.js";

const config = configFrom(`
upstreams:
  oai: { type: openai, baseUrl: "{{openai}}" }
  ant: { type: anthropic, baseUrl: "{{anthropic}}" }
models:
  fast: { targets: [oai/small] }
  smart: { targets: [ant/claude-sonnet-5-5, oai/large] }
  long: { targets: [ant/claude-opus-5-5] }
routing:
  rules:
    - name: premium
      when: { header: { X-Gateway-Tier: premium } }
      route: smart
    - name: research-team
      when: { metadata: { team: research } }
      route: smart
    - name: big-prompts
      when: { model: [fast, smart], minPromptTokens: 1000 }
      route: long
`);

const req = (model: string, content = "hi", extra: Record<string, unknown> = {}) => ({ model, messages: [{ role: "user" as const, content }], ...extra });

describe("router", () => {
  it("resolves an alias to its ordered fallback chain", () => {
    const d = routeRequest(config, "openai", req("smart"), new Headers());
    expect(d).toMatchObject({ route: "smart", targets: [{ upstream: "ant", model: "claude-sonnet-5-5" }, { upstream: "oai", model: "large" }] });
    expect(d.rule).toBeUndefined();
  });

  it("matches header rules case-insensitively and overrides the requested model", () => {
    const d = routeRequest(config, "openai", req("fast"), new Headers({ "x-gateway-tier": "premium" }));
    expect(d).toMatchObject({ route: "smart", rule: "premium" });
  });

  it("matches request metadata", () => {
    const d = routeRequest(config, "anthropic", { ...req("fast"), max_tokens: 1, metadata: { team: "research" } }, new Headers());
    expect(d.rule).toBe("research-team");
  });

  it("routes by estimated prompt size, and only for the listed models", () => {
    const big = "x".repeat(4000 * 4);
    expect(routeRequest(config, "openai", req("fast", big), new Headers())).toMatchObject({ route: "long", rule: "big-prompts" });
    expect(routeRequest(config, "openai", req("fast", "short"), new Headers()).route).toBe("fast");
    expect(routeRequest(config, "openai", req("oai/other", big), new Headers()).route).toBe("oai/other");
  });

  it("evaluates rules in order (first match wins)", () => {
    const d = routeRequest(config, "openai", req("fast", "x".repeat(8000)), new Headers({ "x-gateway-tier": "premium" }));
    expect(d.rule).toBe("premium");
  });

  it("supports direct upstream/model addressing unless disabled", () => {
    expect(routeRequest(config, "openai", req("ant/claude-haiku-5-5"), new Headers()).targets).toEqual([{ upstream: "ant", model: "claude-haiku-5-5" }]);
    const locked = { ...config, routing: { ...config.routing, allowDirect: false } };
    expect(() => routeRequest(locked, "openai", req("ant/claude-haiku-5-5"), new Headers())).toThrow(GatewayError);
    expect(() => routeRequest(config, "openai", req("unknown"), new Headers())).toThrow(/not a configured alias/);
  });

  it("validates that rules point at existing aliases", () => {
    expect(() =>
      configFrom(`
upstreams: { oai: { type: openai, baseUrl: "{{openai}}" } }
routing: { rules: [ { when: { header: { a: b } }, route: missing } ] }
`),
    ).toThrow(/unknown model alias "missing"/);
    expect(() =>
      configFrom(`
upstreams: { oai: { type: openai, baseUrl: "{{openai}}" } }
models: { a: { targets: [oai/x] } }
routing: { rules: [ { when: {}, route: a } ] }
`),
    ).toThrow(/at least one condition/);
  });
});

describe("prompt token estimate", () => {
  it("counts text in messages, system and tools but not image payloads", () => {
    const n = estimatePromptTokens("anthropic", {
      model: "m",
      max_tokens: 1,
      system: "abcd",
      messages: [{ role: "user", content: [{ type: "text", text: "abcdefgh" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100_000) } }] }],
    });
    // "abcd" + "abcdefgh" + the strings "user", "text", "image", "base64", "image/png"
    expect(n).toBeLessThan(20);
  });
});
