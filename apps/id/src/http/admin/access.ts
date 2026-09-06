import * as service from "../../services/access.ts";
import type { Hono } from "hono";
import { resolver } from "hono-openapi";
import { z } from "zod";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
const orgParams = z.object({ organizationId: z.uuid() });
const memberParams = orgParams.extend({ memberId: z.uuid() });
const querySchema = pageQuerySchema
  .extend({ client: z.string().optional(), resource: z.url().optional() })
  .refine(
    (input) => (input.client !== undefined) !== (input.resource !== undefined),
    "Exactly one of client and resource is required",
  );
const memberAccessSchema = z.object({
  effective: z.boolean(),
  targets: z.array(
    z.object({
      kind: z.enum(["client", "resource"]),
      id: z.string(),
      scopes: z.array(z.string()),
      via: z.array(
        z.object({
          entitlementId: z.uuid(),
          principal: z.enum(["organization", "group", "member"]),
          groupId: z.uuid().nullable(),
        }),
      ),
    }),
  ),
});
const targetAccessSchema = z.object({
  items: z.array(
    z.object({
      memberId: z.uuid(),
      userId: z.uuid(),
      email: z.string(),
      name: z.string(),
      scopes: z.array(z.string()),
    }),
  ),
  nextCursor: z.uuid().nullable(),
});
const parameters = (names: string[]) =>
  names.map((name) => ({
    in: "path" as const,
    name,
    required: true,
    schema: { type: "string" as const, format: "uuid" },
  }));
const json = (schema: z.ZodType) => ({
  "application/json": { schema: resolver(schema) },
});
export const routes = {
  getMemberAccess: {
    method: "get",
    path: "/organizations/:organizationId/members/:memberId/access",
    operationId: "getMemberAccess",
    summary: "Get a member's effective access",
    tag: "Access",
    platformScope: "platform:read",
    orgScope: "org:users",
    kind: "read",
    parameters: parameters(["organizationId", "memberId"]),
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: { description: "Success", content: json(memberAccessSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
  listTargetAccess: {
    method: "get",
    path: "/organizations/:organizationId/access",
    operationId: "listTargetAccess",
    summary: "List members with effective access to a target",
    tag: "Access",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    paginated: true,
    parameters: parameters(["organizationId"]),
    example: { query: { resource: "https://none.example" } },
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(targetAccessSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.getMemberAccess,
    validate("param", memberParams),
    async (context) =>
      context.json(
        await service.getMemberAccess(
          context.get("db"),
          context.req.param("organizationId")!,
          context.req.param("memberId")!,
        ),
        200,
      ),
  );
  registerRoute(
    app,
    routes.listTargetAccess,
    validate("param", orgParams),
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await service.listTargetAccess(
          context.get("db"),
          context.req.param("organizationId")!,
          query.client !== undefined
            ? { clientId: query.client }
            : { resource: query.resource! },
          query,
        ),
        200,
      );
    },
  );
}
