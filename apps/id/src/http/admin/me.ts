import type { Hono } from "hono";
import { resolver } from "hono-openapi";
import { z } from "zod";
import { authorizeAny } from "../authorize.ts";
import type { AppEnvironment } from "../context.ts";
import { adminRoute, standardResponses } from "./openapi.ts";
import { adminScopes } from "./scopes.ts";
import type { AdminRoute } from "./route-table.ts";

export const meSchema = z.object({
  principal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("root"), scopes: z.array(z.string()) }),
    z.object({
      type: z.literal("user"),
      userId: z.string(),
      email: z.string(),
      sessionId: z.string(),
    }),
    z.object({
      type: z.literal("client"),
      clientId: z.string(),
      organizationId: z.string(),
    }),
  ]),
  grants: z.array(
    z.object({
      organizationId: z.string(),
      organizationSlug: z.string(),
      scopes: z.array(z.string()),
    }),
  ),
});

export const routes = {
  me: {
    method: "get",
    path: "/me",
    operationId: "getAdminMe",
    summary: "Get the current principal and grants",
    tag: "Me",
    platformScope: "platform:read",
    kind: "read",
    anyGrant: true,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Current principal and effective grants",
          content: { "application/json": { schema: resolver(meSchema) } },
        },
      },
    ),
  },
} satisfies Record<string, AdminRoute>;

export function register(app: Hono<AppEnvironment>) {
  app.get(routes.me.path, adminRoute(routes.me), authorizeAny(), (context) => {
    const { grants, ...principal } = context.get("principal")!;
    if (principal.type === "root")
      return context.json({
        principal: { type: "root", scopes: [...adminScopes] },
        grants: [],
      });
    return context.json({ principal, grants });
  });
}
