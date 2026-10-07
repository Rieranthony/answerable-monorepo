import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { resolver } from "hono-openapi";
import { z } from "zod";
import type { AppEnvironment } from "./context.ts";

export class ProblemError extends Error {
  override name = "ProblemError";

  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    public readonly title: string,
    public readonly detail?: string,
    public readonly extensions?: Record<string, unknown>,
  ) {
    super(title);
  }
}

/** The row, or a 404 problem with this title when it is missing. */
export function found<T>(row: T | null | undefined, title = "Not found"): T {
  if (!row) throw new ProblemError(404, "not_found", title);
  return row;
}

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number(),
    code: z.string(),
    request_id: z.string(),
    detail: z.string().optional(),
  })
  .loose();

export function problem(
  context: Context<AppEnvironment>,
  error: ProblemError,
): Response {
  if (
    error.code === "database_busy" ||
    error.code === "authentication_unavailable"
  )
    context.header("Retry-After", "1");
  return context.json(
    {
      type: "about:blank",
      title: error.title,
      status: error.status,
      code: error.code,
      detail: error.detail,
      request_id: context.get("requestId"),
      ...error.extensions,
    },
    error.status,
    { "Content-Type": "application/problem+json" },
  );
}

const descriptions: Record<number, string> = {
  400: "The request is invalid",
  401: "Authentication is required",
  403: "The principal is not allowed",
  404: "Not found",
  409: "Conflict",
  412: "Configuration revision does not match",
  503: "Service unavailable",
  500: "Unexpected error",
};

export function problemResponses(...statuses: number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: descriptions[status] ?? "HTTP error",
        ...(status === 503
          ? {
              headers: {
                "Retry-After": {
                  description:
                    "For database_busy or authentication_unavailable, seconds to wait before retrying the same command.",
                  schema: { type: "string" as const },
                },
              },
            }
          : {}),
        content: {
          "application/problem+json": { schema: resolver(problemSchema) },
        },
      },
    ]),
  );
}

function databaseBusy() {
  return new ProblemError(
    503,
    "database_busy",
    "Database is busy",
    "Retry with the same idempotency key and input.",
    { retryable: true },
  );
}

/** A Postgres error's SQLSTATE and constraint, when this is one. */
function postgresError(candidate: unknown) {
  return typeof candidate === "object" &&
    candidate !== null &&
    "code" in candidate &&
    typeof candidate.code === "string" &&
    /^[0-9A-Z]{5}$/.test(candidate.code)
    ? (candidate as { code: string; constraint?: unknown })
    : undefined;
}

/** The Postgres error a query wrapped: drizzle reports it as the cause. */
const queryCause = (error: unknown) =>
  postgresError(
    typeof error === "object" && error !== null && "cause" in error
      ? error.cause
      : undefined,
  );

/** A failure that the same command may retry: a statement or lock timeout, a
 * deadlock, or a pool checkout timeout. */
export function isRetryableDatabaseError(error: unknown) {
  // pg-pool has no error code for checkout/connection timeouts. Keep its exact
  // pinned-driver messages here; queries wrap them, transaction checkout does not.
  if (
    [error, error instanceof Error ? error.cause : undefined].some(
      (candidate) =>
        candidate instanceof Error &&
        (candidate.message === "timeout exceeded when trying to connect" ||
          candidate.message ===
            "Connection terminated due to connection timeout"),
    )
  )
    return true;
  const code = queryCause(error)?.code;
  return code === "57014" || code === "55P03" || code === "40P01";
}

export function mapDatabaseError(error: unknown): ProblemError | undefined {
  if (isRetryableDatabaseError(error)) return databaseBusy();
  const cause = queryCause(error);
  switch (cause?.code) {
    case "23505":
      return new ProblemError(
        409,
        "conflict",
        "Conflict",
        typeof cause.constraint === "string"
          ? `A row already exists for ${cause.constraint}.`
          : undefined,
      );
    case "23503":
      return new ProblemError(409, "reference_violation", "Conflict");
    case "23514":
      return new ProblemError(
        400,
        "constraint_violation",
        "The request is invalid",
      );
    default:
      return undefined;
  }
}

/** What a log may say about an unexpected error: its class and, for a Postgres
 * error, the SQLSTATE and constraint. Never the message, which can carry query
 * parameters and credentials. */
export function errorFields(error: unknown) {
  const database = postgresError(error) ?? queryCause(error);
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(database && { code: database.code }),
    ...(typeof database?.constraint === "string" && {
      constraint: database.constraint,
    }),
  };
}

export const problemHandler: ErrorHandler<AppEnvironment> = (
  error,
  context,
) => {
  if (error instanceof ProblemError) return problem(context, error);
  if (error instanceof HTTPException) {
    return problem(
      context,
      new ProblemError(
        error.status as ContentfulStatusCode,
        "http_error",
        descriptions[error.status] ?? "HTTP error",
        error.message,
      ),
    );
  }
  const mapped = mapDatabaseError(error);
  if (mapped) return problem(context, mapped);
  console.error(
    "[id] error",
    JSON.stringify({
      requestId: context.get("requestId"),
      event: "unexpected_error",
      ...errorFields(error),
    }),
  );
  return problem(
    context,
    new ProblemError(500, "internal_error", "Unexpected error"),
  );
};
