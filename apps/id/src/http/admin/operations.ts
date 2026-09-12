import type { Hono } from "hono";
import { z } from "zod";
import { getAuditOperationStatus } from "../../services/operation-status.ts";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";

const response = standardResponses(
  {},
  {
    200: {
      description: "Committed operation; result reference only",
      content: json(
        z.object({
          id: z.uuid(),
          name: z.string(),
          outcome: z.enum(["applied", "noop"]),
          statusCode: z.number().int(),
          resultReference: z.object({ type: z.string(), id: z.string() }),
          committedAt: z.iso.datetime(),
        }),
      ),
    },
    ...problemResponses(400, 404),
  },
);
export const routes = {
  getOperation: {
    method: "get",
    path: "/operations/:operationId",
    operationId: "getOperationStatus",
    summary: "Get an operation status",
    tag: "Operations",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
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
      context.header("Cache-Control", "no-store");
      const result = await getAuditOperationStatus(
        context.get("db"),
        context.req.param("operationId")!,
        {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
        },
      );
      return context.json(result);
    },
  );
}
