/** Server-Sent Events parsing and encoding (https://html.spec.whatwg.org/multipage/server-sent-events.html). */

export interface SSEEvent {
  event?: string;
  data: string;
}

/** Incremental parser; feed it arbitrary text chunks, get complete events back. */
export class SSEParser {
  private buffer = "";
  private event: string | undefined;
  private data: string[] = [];

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const out: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.nextLineEnd()) !== -1) {
      const line = this.buffer.slice(0, idx);
      const skip = this.buffer[idx] === "\r" && this.buffer[idx + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(idx + skip);
      const ev = this.processLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** Flush a trailing event that was not terminated by a blank line. */
  end(): SSEEvent[] {
    const out: SSEEvent[] = [];
    if (this.buffer.length > 0) {
      const ev = this.processLine(this.buffer);
      this.buffer = "";
      if (ev) out.push(ev);
    }
    const ev = this.processLine("");
    if (ev) out.push(ev);
    return out;
  }

  private nextLineEnd(): number {
    const n = this.buffer.indexOf("\n");
    const r = this.buffer.indexOf("\r");
    if (r === -1) return n;
    // A lone trailing \r might be the first half of \r\n; wait for more input.
    if (r === this.buffer.length - 1) return n === -1 ? -1 : Math.min(n, r);
    return n === -1 ? r : Math.min(n, r);
  }

  private processLine(line: string): SSEEvent | undefined {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = undefined;
        return undefined;
      }
      const ev: SSEEvent = { data: this.data.join("\n") };
      if (this.event) ev.event = this.event;
      this.event = undefined;
      this.data = [];
      return ev;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }
}

/** bytes -> SSE events */
export function sseDecoderStream(): TransformStream<Uint8Array, SSEEvent> {
  const decoder = new TextDecoder();
  const parser = new SSEParser();
  return new TransformStream({
    transform(chunk, controller) {
      for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) controller.enqueue(ev);
    },
    flush(controller) {
      for (const ev of parser.push(decoder.decode())) controller.enqueue(ev);
      for (const ev of parser.end()) controller.enqueue(ev);
    },
  });
}

export function encodeSSE(ev: SSEEvent): string {
  const head = ev.event ? `event: ${ev.event}\n` : "";
  return head + ev.data.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
}

export function encodeSSEComment(text: string): string {
  return `: ${text}\n\n`;
}

/** SSE events -> bytes */
export function sseEncoderStream(): TransformStream<SSEEvent | string, Uint8Array> {
  const encoder = new TextEncoder();
  return new TransformStream({
    transform(ev, controller) {
      controller.enqueue(encoder.encode(typeof ev === "string" ? ev : encodeSSE(ev)));
    },
  });
}

/** A finite stream of already-built events (cache replay, JSON-to-stream fallback). */
export function eventStream(events: SSEEvent[]): ReadableStream<SSEEvent> {
  return new ReadableStream({
    start(controller) {
      for (const ev of events) controller.enqueue(ev);
      controller.close();
    },
  });
}

/** A whole SSE body as bytes (used by the mock upstream). */
export function sseBody(events: Array<SSEEvent | string>): ReadableStream<Uint8Array> {
  return eventStream(events as SSEEvent[]).pipeThrough(sseEncoderStream());
}
