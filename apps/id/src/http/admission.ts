import type { Database } from "../db/client.ts";
import type { MiddlewareHandler } from "hono";
import type { AppEnvironment } from "./context.ts";

/** One counter per application instance; no queue and no early release on disconnect. */
export function limitConcurrentRequests(
  maximum: number,
): MiddlewareHandler<AppEnvironment> {
  let active = 0;
  return async (context, next) => {
    if (
      context.req.path === "/healthz" &&
      ["GET", "HEAD"].includes(context.req.method) &&
      context.req.raw.body === null
    )
      return next();
    if (active >= maximum) {
      void context.req.raw.body?.cancel().catch(() => {});
      return context.text("Service Busy", 503, {
        "Retry-After": "1",
        "Cache-Control": "no-store",
      });
    }
    active++;
    try {
      await next();
    } finally {
      active--;
    }
  };
}

const authenticationLimits = new WeakMap<
  Database["$client"],
  MiddlewareHandler<AppEnvironment>
>();

/** Public /auth work shares one bound per pool, including aliases/app objects.
 * Keep its request count below pool size when the pool has at least two.
 * This is a handler bound, not a dedicated connection reservation.
 */
export function limitAuthenticationRequests(
  db: Database,
): MiddlewareHandler<AppEnvironment> {
  const pool = db.$client;
  let admission = authenticationLimits.get(pool);
  if (!admission) {
    admission = limitConcurrentRequests(
      Math.max(1, (pool.options.max ?? 10) - 1),
    );
    authenticationLimits.set(pool, admission);
  }
  return admission;
}

/** Preserve route-specific JSON errors alongside the pre-authentication transport refusal. */
export function withAdmissionResponse(
  response?: unknown,
  scope: "request" | "authentication" = "request",
) {
  const current = (response ?? {}) as {
    description?: string;
    headers?: object;
    content?: object;
  };
  return {
    ...current,
    description: `${current.description ? current.description + " " : ""}Request admission may also return plain text Service Busy before authentication or body acquisition when ${scope === "authentication" ? "this instance or its pool’s authentication capacity is full" : "this instance is full"}. Retry after the indicated delay; retain the same key and input for an administrative command.`,
    headers: {
      ...current.headers,
      "Retry-After": {
        description: "Minimum delay in seconds before retrying.",
        schema: { type: "string" as const, example: "1" },
      },
    },
    content: {
      ...current.content,
      "text/plain": {
        schema: { type: "string" as const, example: "Service Busy" },
      },
    },
  };
}
