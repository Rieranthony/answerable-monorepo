import { tenantRead } from "./tenant-read.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";
import * as service from "../../services/access.ts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
const orgParams = uuidParam("organizationId");
const memberParams = orgParams.extend({ memberId: z.uuid() });
const querySchema = pageQuerySchema
  .extend({ clientId: z.string().optional(), resource: z.url().optional() })
  .refine(
    (input) => input.clientId !== undefined || input.resource !== undefined,
    "A client, resource or exact pair is required",
  );
const sourceSchema = z.object({
  id: z.uuid(),
  revision: z.number().int(),
  resource: z.string().nullable(),
  scopes: z.array(z.string()),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
});
const permissionSchema = z.discriminatedUnion("allowed", [
  z.object({
    allowed: z.literal(false),
    reason: z.enum(["context", "login", "capability", "scope"]),
  }),
  z.object({
    allowed: z.literal(true),
    reason: z.literal("approved"),
    grantType: z.enum(["authorization_code", "refresh_token", "admin_session"]),
    subjectType: z.literal("user"),
    organization: z.object({
      id: z.uuid(),
      authorizationVersion: z.number().int(),
    }),
    subject: z.object({ userId: z.uuid(), memberId: z.uuid() }),
    client: z
      .object({
        id: z.uuid(),
        clientId: z.string(),
        revision: z.number().int(),
        authorizationVersion: z.number().int(),
        scopeCeiling: z.array(z.string()).nullable(),
      })
      .nullable(),
    resource: z
      .object({
        id: z.uuid(),
        identifier: z.string(),
        revision: z.number().int(),
        scopeCeiling: z.array(z.string()).nullable(),
      })
      .nullable(),
    requestedScopes: z.array(z.string()).nullable(),
    scopes: z.array(z.string()),
    evidence: z.object({
      policyVersion: z.number().int(),
      evaluatedAt: z.string(),
      membership: z.object({
        id: z.uuid(),
        revision: z.number().int(),
        validFrom: z.string().nullable(),
        validUntil: z.string().nullable(),
      }),
      capabilities: z.array(sourceSchema.extend({ grantKind: z.string() })),
      assignments: z.array(
        sourceSchema.extend({
          memberId: z.uuid().nullable(),
          groupId: z.uuid().nullable(),
          groupMembership: z
            .object({
              id: z.uuid(),
              revision: z.number().int(),
              groupRevision: z.number().int(),
              validFrom: z.string().nullable(),
              validUntil: z.string().nullable(),
            })
            .nullable(),
        }),
      ),
    }),
  }),
]);
const memberAccessSchema = z.object({
  effective: z.boolean(),
  targets: z.array(
    z.intersection(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("client"), id: z.string() }),
        z.object({ kind: z.literal("resource"), id: z.string() }),
        z.object({
          kind: z.literal("client_resource"),
          id: z.string(),
          resource: z.url(),
        }),
      ]),
      z.object({
        scopes: z.array(z.string()),
        permission: permissionSchema,
        via: z.array(
          z.object({
            entitlementId: z.uuid(),
            principal: z.enum(["organization", "group", "member"]),
            groupId: z.uuid().nullable(),
          }),
        ),
      }),
    ),
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
      permission: permissionSchema,
    }),
  ),
  nextCursor: z.uuid().nullable(),
});
export const routes = {
  getMemberAccess: {
    method: "get",
    path: "/organizations/:organizationId/members/:memberId/access",
    operationId: "getMemberAccess",
    summary: "Inspect a member's assignments and permissions",
    description:
      "Return effective assignment targets, assigned scopes and sources. Every target includes current permission and source evidence: client-only login admission, exact client/resource authorization-code permission, or resource-only direct administration. Permission is not authentication, consent, refresh approval or a promise that a token can be issued. Top-level scopes remain assignment projections; permission.scopes contains the approved scopes. Prefer listTargetAccess to find all members for one client, resource or exact pair; validation_failed rejects malformed ids and not_found means the member or organisation is unavailable.",
    tag: "Access",
    platformScope: "platform:read",
    orgScope: "org:users",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
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
    summary: "List assigned members and current permissions",
    description:
      "Return a cursor page of members with effective assignments to one client, resource or exact pair. Scopes are assigned scopes, not a permission promise. Every row includes permission and source evidence for client-only login, exact client/resource authorization-code use or resource-only direct administration. Denied members stay in the page so the assignment can be diagnosed. Prefer getMemberAccess to inspect one member across targets; validation_failed rejects missing or malformed targets and not_found means the organisation or target is unavailable, including a resource private to another organisation.",
    tag: "Access",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    parameters: [
      pathParameter("organizationId", "uuid"),
      { in: "query", name: "clientId", schema: { type: "string" } },
      {
        in: "query",
        name: "resource",
        schema: { type: "string", format: "uri" },
      },
    ],
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
        await tenantRead(context, "memberAccess", (tenant) =>
          service.getMemberAccess(tenant, context.req.param("memberId")!),
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
        await tenantRead(context, "directory", (tenant) =>
          service.listTargetAccess(
            tenant,
            query.clientId !== undefined
              ? { clientId: query.clientId, resource: query.resource }
              : { resource: query.resource! },
            query,
          ),
        ),
        200,
      );
    },
  );
}
