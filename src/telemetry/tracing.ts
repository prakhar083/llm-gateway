import { trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { TelemetryConfig } from "../config/schema.js";
import { VERSION } from "../version.js";

export interface Tracing {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

/**
 * Registers a global tracer provider exporting OTLP/HTTP. When tracing is
 * disabled the API's no-op tracer is returned, so instrumentation costs ~nothing.
 */
export function initTracing(cfg: TelemetryConfig): Tracing {
  if (!cfg.tracing.enabled) return { tracer: trace.getTracer("llm-gateway"), shutdown: async () => {} };
  const url = cfg.tracing.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: cfg.serviceName, [ATTR_SERVICE_VERSION]: VERSION }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(cfg.tracing.sampleRatio) }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(url ? { url } : {}))],
  });
  provider.register();
  return { tracer: provider.getTracer("llm-gateway", VERSION), shutdown: () => provider.shutdown() };
}
