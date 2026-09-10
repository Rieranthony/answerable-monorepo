import type { MiddlewareHandler } from "hono";
import type { AppEnvironment } from "./context.ts";

export const maxRequestBodyBytes = 256 * 1024;
export const requestBodyTimeoutMs = 5_000;

export const requestBoundaryResponses = {
  408: {
    description:
      "The request body did not finish within five seconds. Send a complete body in a new request. This is a transport response, not a problem-details response.",
  },
  413: {
    description: `The request body exceeds ${maxRequestBodyBytes} bytes (256 KiB). Reduce the payload. This transport response may precede application headers and is not a problem-details response.`,
  },
};

const rejected = (status: 400 | 408 | 413, message: string) =>
  new Response(message, { status, headers: { "Cache-Control": "no-store" } });

/** Bound body acquisition before parsing, authentication or any command starts. */
export const limitRequestBody: MiddlewareHandler<AppEnvironment> = async (
  context,
  next,
) => {
  const request = context.req.raw;
  if (!request.body) return next();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let body: Uint8Array<ArrayBuffer>;
  try {
    const result = await Promise.race([
      (async () => {
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxRequestBodyBytes)
            return rejected(413, "Payload Too Large");
          if (value.byteLength) chunks.push(value);
        }
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      })(),
      new Promise<Response>((resolve) => {
        timer = setTimeout(
          () => resolve(rejected(408, "Request Timeout")),
          requestBodyTimeoutMs,
        );
      }),
    ]);
    if (result instanceof Response) return result;
    body = result;
  } catch {
    return rejected(400, "Invalid Request Body");
  } finally {
    clearTimeout(timer);
    // Cancellation must not delay the response if an input stream's cleanup stalls.
    void reader.cancel().catch(() => {});
  }
  const headers = new Headers(request.headers);
  headers.delete("transfer-encoding");
  headers.set("content-length", String(body.byteLength));
  context.req.raw = new Request(request, { headers, body });
  return next();
};
