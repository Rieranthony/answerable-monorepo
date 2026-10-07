import type { ValidationTargets } from "hono";
import { validator } from "hono-openapi";
import type { z } from "zod";
import type { AppEnvironment } from "./context.ts";
import { problem, ProblemError } from "./problem.ts";

// Hono's JSON validator reads a body only under this Content-Type (its own
// pattern) and otherwise validates {}, which a schema of optional fields accepts.
const jsonContentType =
  /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

const invalid = (errors: { path: string; message: string }[]) =>
  new ProblemError(
    400,
    "validation_failed",
    "The request is invalid",
    undefined,
    {
      errors,
    },
  );

export function validate<
  Schema extends z.ZodType,
  Target extends keyof ValidationTargets,
>(target: Target, schema: Schema) {
  return validator<Schema, Target, AppEnvironment, string>(
    target,
    schema,
    (result, context) => {
      if (
        target === "json" &&
        !jsonContentType.test(context.req.header("Content-Type") ?? "")
      )
        return problem(
          context,
          invalid([{ path: "", message: "Send the body as application/json" }]),
        );
      if (!result.success)
        return problem(
          context,
          invalid(
            result.error.map((issue) => ({
              path: issue.path?.map(String).join(".") ?? "",
              message: issue.message,
            })),
          ),
        );
    },
  );
}
