import type { ValidationTargets } from "hono";
import { validator } from "hono-openapi";
import type { z } from "zod";
import type { AppEnvironment } from "./context.ts";
import { problem, ProblemError } from "./problem.ts";

export function validate<
  Schema extends z.ZodType,
  Target extends keyof ValidationTargets,
>(target: Target, schema: Schema) {
  return validator<Schema, Target, AppEnvironment, string>(
    target,
    schema,
    (result, context) => {
      if (!result.success) {
        return problem(
          context,
          new ProblemError(
            400,
            "validation_failed",
            "The request is invalid",
            undefined,
            {
              errors: result.error.map((issue) => ({
                path: issue.path?.map(String).join(".") ?? "",
                message: issue.message,
              })),
            },
          ),
        );
      }
    },
  );
}
