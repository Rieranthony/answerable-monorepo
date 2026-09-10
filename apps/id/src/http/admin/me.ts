import { json } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnvironment } from "../context.ts";
import { standardResponses } from "./openapi.ts";
import { adminScopes } from "./scopes.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";

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
      isPlatform: z.boolean(),
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
    description:
      "Return the authenticated principal and effective grants, including an empty grants array when no scopes are held; this read changes nothing. Use this before choosing an operation and its required scope; unauthenticated or invalid_token means authentication must be renewed.",
    tag: "Me",
    platformScope: "platform:read",
    kind: "read",
    open: true,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Current principal and effective grants",
          content: json(meSchema),
        },
      },
    ),
  },
} satisfies Record<string, AdminRoute>;

export function register(app: Hono<AppEnvironment>) {
  registerRoute(app, routes.me, (context) => {
    const { grants, ...principal } = context.get("principal")!;
    if (principal.type === "root")
      return context.json({
        principal: { type: "root", scopes: [...adminScopes] },
        grants: [],
      });
    return context.json({ principal, grants });
  });
}
