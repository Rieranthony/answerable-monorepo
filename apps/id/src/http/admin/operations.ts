import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { adminOperations } from "../../db/schema/index.ts";
import { operationOutcomes } from "../../db/schema/vocabulary.ts";
import type { AppEnvironment } from "../context.ts";
import { found, problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { platformRead } from "./platform-read.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";

const response = {
  200: {
    description: "Committed operation; result reference only",
    content: json(
      z.object({
        id: z.uuid(),
        name: z.string(),
        outcome: z.enum(operationOutcomes),
        statusCode: z.number().int(),
        resultReference: z.object({ type: z.string(), id: z.string() }),
        committedAt: z.iso.datetime(),
      }),
    ),
  },
  ...problemResponses(400, 404),
};
export const routes = {
  getOperation: {
    method: "get",
    path: "/operations/:operationId",
    operationId: "getOperationStatus",
    summary: "Get an operation status",
    tag: "Operations",
    platformScope: "platform:read",
    kind: "read",
    description:
      "Read a committed operation with platform audit authority. Returns its outcome and result reference. not_found means no committed operation exists; this does not prove that a concurrent request is not running. Every administrative mutation creates a journal record.",
    parameters: [pathParameter("operationId", "uuid")],
    responses: response,
  },
} satisfies Record<string, AdminRoute>;

export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.getOperation,
    validate("param", uuidParam("operationId")),
    async (context) => {
      const [operation] = await platformRead(context, ({ tx }) =>
        tx
          .select({
            id: adminOperations.id,
            name: adminOperations.name,
            outcome: adminOperations.outcome,
            statusCode: adminOperations.statusCode,
            resultReference: adminOperations.resultReference,
            committedAt: adminOperations.committedAt,
          })
          .from(adminOperations)
          .where(eq(adminOperations.id, context.req.param("operationId")!)),
      );
      return context.json(found(operation, "Operation not found"));
    },
  );
}
