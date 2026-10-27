/**
 * Environment-variable interpolation for parsed config values.
 *
 * Interpolation runs on the parsed YAML tree rather than the raw text, so a
 * secret containing YAML metacharacters (`:`, `#`, quotes) can never change the
 * structure of the document.
 *
 *   ${VAR}            value of VAR; an error if VAR is unset
 *   ${VAR:-fallback}  value of VAR, or `fallback` if VAR is unset or empty
 *   $${VAR}           a literal `${VAR}`
 */
const PATTERN = /\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class InterpolationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing environment variables referenced in config: ${missing.join(", ")}`);
    this.name = "InterpolationError";
  }
}

export function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const missing = new Set<string>();
  const result = walk(value, env, missing);
  if (missing.size > 0) throw new InterpolationError([...missing].sort());
  return result;
}

function walk(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === "string") return interpolateString(value, env, missing);
  if (Array.isArray(value)) return value.map((v) => walk(v, env, missing));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, env, missing)]),
    );
  }
  return value;
}

function interpolateString(input: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return input.replace(PATTERN, (match, escape: string, name: string, fallback: string | undefined) => {
    if (escape) return match.slice(1);
    const v = env[name];
    if (fallback !== undefined) return v === undefined || v === "" ? fallback : v;
    if (v === undefined) {
      missing.add(name);
      return "";
    }
    return v;
  });
}
