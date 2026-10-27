import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/load.js";
import { interpolateEnv, InterpolationError } from "../src/config/interpolate.js";

const minimal = `
upstreams:
  openai:
    type: openai
    baseUrl: https://api.openai.com/v1
    apiKey: \${OPENAI_API_KEY}
models:
  fast:
    targets:
      - openai/gpt-mini
      - { upstream: openai, model: gpt-large }
`;

describe("config parsing", () => {
  it("parses a minimal config and applies defaults", () => {
    const cfg = parseConfig(minimal, { OPENAI_API_KEY: "sk-test" });
    expect(cfg.server.port).toBe(8080);
    expect(cfg.upstreams.openai!.apiKey).toBe("sk-test");
    expect(cfg.upstreams.openai!.timeoutMs).toBe(60_000);
    expect(cfg.models.fast!.targets).toEqual([
      { upstream: "openai", model: "gpt-mini" },
      { upstream: "openai", model: "gpt-large" },
    ]);
  });

  it("reports every missing env var at once", () => {
    const yaml = `
upstreams:
  a: { type: openai, baseUrl: "https://a.example/v1", apiKey: "\${KEY_A}" }
  b: { type: anthropic, baseUrl: "https://b.example", apiKey: "\${KEY_B}" }
`;
    expect(() => parseConfig(yaml, {})).toThrow(/KEY_A, KEY_B/);
  });

  it("rejects targets that reference unknown upstreams", () => {
    const yaml = `
upstreams:
  openai: { type: openai, baseUrl: "https://api.openai.com/v1" }
models:
  smart: { targets: [ "anthropic/claude-sonnet-5-5" ] }
`;
    expect(() => parseConfig(yaml, {})).toThrow(/unknown upstream "anthropic"/);
  });

  it("rejects invalid YAML and invalid types with a ConfigError", () => {
    expect(() => parseConfig("upstreams: [", {})).toThrow(ConfigError);
    expect(() =>
      parseConfig(`upstreams: { x: { type: grpc, baseUrl: "https://x" } }`, {}),
    ).toThrow(/invalid gateway config/);
    expect(() => parseConfig(`upstreams: {}`, {})).toThrow(/at least one upstream/);
  });
});

describe("env interpolation", () => {
  it("supports defaults, escapes and nested structures", () => {
    const out = interpolateEnv(
      { a: "${A}", b: ["${B:-fallback}", "x-${A}-y"], c: { d: "$${LITERAL}" }, n: 3 },
      { A: "1", B: "" },
    );
    expect(out).toEqual({ a: "1", b: ["fallback", "x-1-y"], c: { d: "${LITERAL}" }, n: 3 });
  });

  it("does not let secret values alter YAML structure", () => {
    const cfg = parseConfig(minimal, { OPENAI_API_KEY: "a: b\n- c # d" });
    expect(cfg.upstreams.openai!.apiKey).toBe("a: b\n- c # d");
  });

  it("throws InterpolationError listing missing variables", () => {
    try {
      interpolateEnv({ x: "${NOPE}" }, {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InterpolationError);
      expect((err as InterpolationError).missing).toEqual(["NOPE"]);
    }
  });
});
