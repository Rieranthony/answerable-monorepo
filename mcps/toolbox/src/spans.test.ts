import { expect, test } from "bun:test"
import { defineTool, ToolError, type ToolCall } from "@answerable/mcp"
import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import { z } from "zod"
import { createMemoryTracer, createTracer, traced } from "./spans"
import { principal } from "./test/principal"

const tool = { ...defineTool({ name: "records.list", description: "A fixture read that lists nothing and changes nothing.", input: z.object({}), output: z.object({}), async execute() { return {} } }), identity: "e2e/records.list", version: "2026-09-29", scopes: [] }
const call = (meta: Record<string, unknown> = {}): ToolCall => ({ tool, name: "e2e_records_list", principal: principal(), executionId: Bun.randomUUIDv7(), requestId: 7, meta })
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

test("one server span per call, named after the capability, with the MCP, GenAI and Answerable attributes", async () => {
  const { tracer, spans } = createMemoryTracer()
  const one = call()
  expect(await traced(tracer, one, "https://toolbox.test/mcp", async span => {
    span.setAttribute("answerable.outcome", "success")
    return "done"
  })).toBe("done")
  const [span] = spans()
  expect(span!.name).toBe("tools/call e2e/records.list")
  expect(span!.kind).toBe(SpanKind.SERVER)
  expect(span!.parentSpanContext).toBeUndefined()
  expect(span!.attributes).toEqual({
    "mcp.method.name": "tools/call",
    "gen_ai.tool.name": "e2e_records_list",
    "gen_ai.tool.call.id": one.executionId,
    "jsonrpc.request.id": "7",
    "answerable.organisation.id": one.principal.organizationId,
    "answerable.user.hash": sha256(`https://toolbox.test/mcp:${one.principal.userId}`),
    "answerable.client.name": "claude-code",
    "answerable.capability.identity": "e2e/records.list",
    "answerable.capability.version": "2026-09-29",
    "answerable.outcome": "success",
  })
  expect(JSON.stringify(span!.attributes)).not.toContain(one.principal.userId)
})

test("a W3C traceparent in the request's _meta is the span's parent; anything else starts a new trace", async () => {
  const { tracer, spans } = createMemoryTracer()
  await traced(tracer, call({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }), "salt", async () => {})
  for (const traceparent of ["00-00000000000000000000000000000000-00f067aa0ba902b7-01", "not a traceparent", 42]) await traced(tracer, call({ traceparent }), "salt", async () => {})
  const [child, ...roots] = spans()
  expect(child!.spanContext().traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
  expect(child!.parentSpanContext?.spanId).toBe("00f067aa0ba902b7")
  expect(roots.map(span => span.parentSpanContext)).toEqual([undefined, undefined, undefined])
})

test("a call that throws ends its span with an error status and the error's code", async () => {
  const { tracer, spans } = createMemoryTracer()
  await expect(traced(tracer, call(), "salt", async () => { throw new ToolError("NOT_FOUND", "No accessible record exists") })).rejects.toThrow("No accessible record exists")
  await expect(traced(tracer, call(), "salt", async () => { throw new Error("private detail") })).rejects.toThrow("private detail")
  expect(spans().map(span => [span.status, span.attributes["error.type"]])).toEqual([
    [{ code: SpanStatusCode.ERROR }, "NOT_FOUND"], [{ code: SpanStatusCode.ERROR }, "INTERNAL"],
  ])
})

test("with an OTLP endpoint, spans are exported over OTLP/HTTP as JSON; without one they are not exported", async () => {
  const received: { path: string; body: { resourceSpans: { resource: { attributes: unknown[] }; scopeSpans: { spans: { name: string }[] }[] }[] } }[] = []
  const collector = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    received.push({ path: new URL(request.url).pathname, body: await request.json() })
    return Response.json({})
  } })
  try {
    const exported = createTracer(`http://127.0.0.1:${collector.port}`)
    await traced(exported.tracer, call(), "salt", async () => {})
    await exported.shutdown()
    expect(received).toHaveLength(1)
    expect(received[0]!.path).toBe("/v1/traces")
    const [resourceSpans] = received[0]!.body.resourceSpans
    expect(resourceSpans!.scopeSpans[0]!.spans.map(span => span.name)).toEqual(["tools/call e2e/records.list"])
    expect(resourceSpans!.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "answerable-toolbox" } })
    const silent = createTracer()
    const span = await traced(silent.tracer, call(), "salt", async span => span.spanContext())
    expect(span.traceId).toMatch(/^(?!0{32})[0-9a-f]{32}$/)
    await silent.shutdown()
    expect(received).toHaveLength(1)
  } finally { collector.stop(true) }
})
