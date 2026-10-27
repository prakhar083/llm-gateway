import type { ApiFormat } from "../errors.js";
import type { ClientRequest } from "../translate/adapter.js";

/**
 * Cheap prompt-size estimate used for routing decisions: characters / 4 over
 * every string in messages, system prompt and tool definitions. Good enough to
 * separate "short chat" from "50k-token document" without shipping a
 * tokenizer per provider; not suitable for billing.
 */
export function estimatePromptTokens(_format: ApiFormat, req: ClientRequest): number {
  let chars = 0;
  const visit = (v: unknown): void => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        // base64 images are billed very differently from text; skip their payload
        if (k === "data" || k === "url") continue;
        visit(val);
      }
    }
  };
  visit(req.messages);
  visit((req as { system?: unknown }).system);
  visit((req as { tools?: unknown }).tools);
  return Math.ceil(chars / 4);
}
