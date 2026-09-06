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

export type Problem = z.output<typeof problemSchema>;

export function problem(
  context: Context<AppEnvironment>,
  error: ProblemError,
): Response {
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
  500: "Unexpected error",
};

export function problemResponses(...statuses: number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: descriptions[status] ?? "HTTP error",
        content: {
          "application/problem+json": { schema: resolver(problemSchema) },
        },
      },
    ]),
  );
}

export function mapDatabaseError(error: unknown): ProblemError | undefined {
  if (typeof error !== "object" || error === null || !("cause" in error))
    return undefined;
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause))
    return undefined;
  switch (cause.code) {
    case "23505":
      return new ProblemError(
        409,
        "conflict",
        "Conflict",
        "constraint" in cause && typeof cause.constraint === "string"
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
      name: error.name,
      message: error.message,
    }),
  );
  return problem(
    context,
    new ProblemError(500, "internal_error", "Unexpected error"),
  );
};
