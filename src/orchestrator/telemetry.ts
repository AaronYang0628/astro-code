type Attributes = Record<string, string | number | boolean | null | undefined>;

export interface SpanLike {
  setAttributes(attrs: Attributes): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: Error): void;
  addEvent(name: string, attrs?: Attributes): void;
  end(): void;
}

const NOOP_SPAN: SpanLike = {
  setAttributes: () => undefined,
  setStatus: () => undefined,
  recordException: () => undefined,
  addEvent: () => undefined,
  end: () => undefined
};

interface OtelRuntime {
  trace: {
    getTracer(name: string, version: string): {
      startActiveSpan<T>(
        name: string,
        options: { attributes?: Attributes },
        fn: (span: SpanLike) => Promise<T>
      ): Promise<T>;
    };
    getActiveSpan(): SpanLike | undefined;
    setSpan(ctx: unknown, span: SpanLike): unknown;
  };
  context: {
    active(): unknown;
    with<T>(ctx: unknown, fn: () => Promise<T>): Promise<T>;
  };
  SpanStatusCode: {
    OK: number;
    ERROR: number;
  };
}

let provider: { shutdown(): Promise<void> } | null = null;
let enabled = false;
let initialized = false;
let runtime: OtelRuntime | null = null;

const TRACER_NAME = "astro-code.orchestrator";
const TRACER_VERSION = "0.1.0";

function envEnabledFlag(): boolean {
  const raw = (process.env.OTEL_ENABLED ?? process.env.ASTRO_OTEL_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveExporterUrl(): string | undefined {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (tracesEndpoint) {
    return tracesEndpoint;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) {
    return undefined;
  }
  return endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/$/, "")}/v1/traces`;
}

function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const piece of raw.split(",")) {
    const item = piece.trim();
    if (!item) {
      continue;
    }
    const idx = item.indexOf("=");
    if (idx <= 0 || idx >= item.length - 1) {
      continue;
    }
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function loadRuntime(): Promise<{
  runtime: OtelRuntime;
  provider: { register(): void; shutdown(): Promise<void> };
  makeExporter: (url?: string) => unknown;
  makeBatchProcessor: (exporter: unknown) => unknown;
  makeResource: (attrs: Attributes) => unknown;
  semconv: {
    SERVICE_NAME: string;
    SERVICE_VERSION: string;
  };
}> {
  const [api, exporter, resources, sdkNode, sdkBase, semconv] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/semantic-conventions")
  ]);

  return {
    runtime: {
      trace: api.trace as OtelRuntime["trace"],
      context: api.context as OtelRuntime["context"],
      SpanStatusCode: api.SpanStatusCode as OtelRuntime["SpanStatusCode"]
    },
    provider: new sdkNode.NodeTracerProvider(),
    makeExporter: (url?: string) => {
      const headers = parseOtlpHeaders(
        process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? process.env.OTEL_EXPORTER_OTLP_HEADERS
      );
      const opts: { url?: string; headers?: Record<string, string> } = {};
      if (url) {
        opts.url = url;
      }
      if (headers) {
        opts.headers = headers;
      }
      return new exporter.OTLPTraceExporter(opts);
    },
    makeBatchProcessor: (exp: unknown) => new sdkBase.BatchSpanProcessor(exp),
    makeResource: (attrs: Attributes) => resources.resourceFromAttributes(attrs),
    semconv: {
      SERVICE_NAME: semconv.SEMRESATTRS_SERVICE_NAME as string,
      SERVICE_VERSION: semconv.SEMRESATTRS_SERVICE_VERSION as string
    }
  };
}

export async function initTelemetry(): Promise<boolean> {
  if (initialized) {
    return enabled;
  }
  initialized = true;

  const exporterUrl = resolveExporterUrl();
  enabled = envEnabledFlag() || Boolean(exporterUrl);
  if (!enabled) {
    return false;
  }

  try {
    const loaded = await loadRuntime();
    runtime = loaded.runtime;

    const resource = loaded.makeResource({
      [loaded.semconv.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME?.trim() || "astro-code-orchestrator",
      [loaded.semconv.SERVICE_VERSION]: TRACER_VERSION
    });
    const exporter = loaded.makeExporter(exporterUrl);
    const batch = loaded.makeBatchProcessor(exporter);

    const nodeProvider = new (await import("@opentelemetry/sdk-trace-node")).NodeTracerProvider({
      resource,
      spanProcessors: [batch]
    });
    nodeProvider.register();
    provider = nodeProvider;
    return true;
  } catch {
    enabled = false;
    runtime = null;
    return false;
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!provider) {
    return;
  }
  await provider.shutdown();
  provider = null;
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export function setActiveSpanAttributes(attributes: Attributes): void {
  if (!enabled || !runtime) {
    return;
  }
  const span = runtime.trace.getActiveSpan();
  if (!span) {
    return;
  }
  span.setAttributes(attributes);
}

export function addActiveSpanEvent(name: string, attributes?: Attributes): void {
  if (!enabled || !runtime) {
    return;
  }
  const span = runtime.trace.getActiveSpan();
  if (!span) {
    return;
  }
  span.addEvent(name, attributes);
}

export function startSpan(name: string, attributes?: Attributes): SpanLike | null {
  if (!enabled || !runtime) {
    return null;
  }
  const tracer = runtime.trace.getTracer(TRACER_NAME, TRACER_VERSION) as unknown as {
    startSpan: (n: string, o?: { attributes?: Attributes }) => SpanLike;
  };
  return tracer.startSpan(name, { attributes });
}

export function endSpanOk(span: SpanLike | null, attributes?: Attributes): void {
  if (!span || !runtime) {
    return;
  }
  if (attributes) {
    span.setAttributes(attributes);
  }
  span.setStatus({ code: runtime.SpanStatusCode.OK });
  span.end();
}

export function endSpanError(span: SpanLike | null, error: unknown, attributes?: Attributes): void {
  if (!span || !runtime) {
    return;
  }
  if (attributes) {
    span.setAttributes(attributes);
  }
  span.recordException(error as Error);
  span.setStatus({
    code: runtime.SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error)
  });
  span.end();
}

export async function withSpan<T>(
  name: string,
  fn: (span: SpanLike) => Promise<T>,
  attributes?: Attributes
): Promise<T> {
  if (!enabled || !runtime) {
    return fn(NOOP_SPAN);
  }

  const tracer = runtime.trace.getTracer(TRACER_NAME, TRACER_VERSION);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: runtime!.SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: runtime!.SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function runWithParentContext<T>(
  parentSpan: SpanLike,
  fn: () => Promise<T>
): Promise<T> {
  if (!enabled || !runtime) {
    return fn();
  }
  const parentContext = runtime.trace.setSpan(runtime.context.active(), parentSpan);
  return runtime.context.with(parentContext, fn);
}
