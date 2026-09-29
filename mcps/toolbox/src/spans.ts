import { ToolError, type ToolCall } from "@answerable/mcp"
import { isSpanContextValid, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BasicTracerProvider, BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"

const service = "answerable-toolbox"
const traceparent = /^(?!ff)[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/

/** A tracer whose spans go to `endpoint` (`OTEL_EXPORTER_OTLP_ENDPOINT`) over OTLP/HTTP as JSON, in batches; without one, spans get ids but go nowhere. */
export function createTracer(endpoint?: string) {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": service }),
    spanProcessors: endpoint ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }))] : [],
  })
  return { tracer: provider.getTracer(service), shutdown: () => provider.shutdown() }
}

/** A tracer that keeps every finished span in memory, for tests. */
export function createMemoryTracer() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  return { tracer: provider.getTracer(service), spans: () => exporter.getFinishedSpans() }
}

// The caller's trace, from the W3C traceparent a host may send in the request's _meta.
function parent(meta: ToolCall["meta"]) {
  const match = typeof meta.traceparent === "string" ? traceparent.exec(meta.traceparent) : null
  const context = match && { traceId: match[1]!, spanId: match[2]!, traceFlags: Number.parseInt(match[3]!, 16), isRemote: true }
  return context && isSpanContextValid(context) ? trace.setSpanContext(ROOT_CONTEXT, context) : ROOT_CONTEXT
}

/**
 * Run one tool call inside a server span named `tools/call <identity>`, with the MCP and GenAI attributes, the organisation, a SHA-256 of
 * `salt` and the user id in place of the id, the client, and the capability's identity and version. A throw sets the error status and `error.type`.
 */
export async function traced<T>(tracer: Tracer, call: ToolCall, salt: string, body: (span: Span) => Promise<T>): Promise<T> {
  const span = tracer.startSpan(`tools/call ${call.tool.identity}`, {
    kind: SpanKind.SERVER,
    attributes: {
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": call.name,
      "gen_ai.tool.call.id": call.executionId,
      "jsonrpc.request.id": String(call.requestId),
      "answerable.organisation.id": call.principal.organizationId,
      "answerable.user.hash": new Bun.CryptoHasher("sha256").update(`${salt}:${call.principal.userId}`).digest("hex"),
      "answerable.client.name": call.principal.clientId,
      "answerable.capability.identity": call.tool.identity,
      "answerable.capability.version": call.tool.version,
    },
  }, parent(call.meta))
  try {
    return await body(span)
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR })
    span.setAttribute("error.type", error instanceof ToolError ? error.code : "INTERNAL")
    throw error
  } finally {
    span.end()
  }
}
