import {
  json,
  body,
  pathParameter,
  uuidParam,
  windowSchema,
  windowDates,
} from "./schemas.ts";
import * as service from "../../services/entitlements.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
const page = (schema: z.ZodType) =>
  z.object({ items: z.array(schema), nextCursor: z.uuid().nullable() });
const orgParams = uuidParam("organizationId");
export const entitlementSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  memberId: z.uuid().nullable(),
  groupId: z.uuid().nullable(),
  clientId: z.string().nullable(),
  resource: z.url().nullable(),
  scopes: z.array(z.string()),
  status: z.enum(lifecycleStatuses),
  validFrom: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const querySchema = pageQuerySchema.extend({
  clientId: z.string().optional(),
  resource: z.url().optional(),
  memberId: z.uuid().optional(),
  groupId: z.uuid().optional(),
  status: z.enum(lifecycleStatuses).optional(),
});
const scopesSchema = z.array(z.string().min(1)).min(1);
const createSchema = windowSchema.extend({
  memberId: z.uuid().optional(),
  groupId: z.uuid().optional(),
  clientId: z.string().min(1).optional(),
  resource: z.url().optional(),
  scopes: scopesSchema,
});
const patchSchema = windowSchema
  .extend({ scopes: scopesSchema.optional() })
  .refine(
    (input) => Object.keys(input).length > 0,
    "At least one field is required",
  );
const entitlementParams = orgParams.extend({ entitlementId: z.uuid() });
export const routes = {
  listEntitlements: {
    method: "get",
    path: "/organizations/:organizationId/entitlements",
    operationId: "listEntitlements",
    summary: "List organisation entitlements",
    description:
      "Return a cursor page of organisation entitlements, without changing state. Prefer getEntitlement for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors and not_found means the organisation or parent is unavailable.",
    tag: "Entitlements",
    platformScope: "platform:read",
    kind: "read",
    parameters: ["organizationId"].map((name) => pathParameter(name, "uuid")),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(page(entitlementSchema)) },
        ...problemResponses(400, 404),
      },
    ),
  },
  createEntitlement: {
    method: "post",
    path: "/organizations/:organizationId/entitlements",
    operationId: "createEntitlement",
    summary: "Create an organisation entitlement",
    description:
      "Create an organisation, group or member entitlement to exactly one clientId or resource and return the entitlement, granting access during its validity window. Prefer updateEntitlement to change existing scopes or dates; validation_failed rejects invalid targets or scopes, not_found means a referenced parent or target is missing, and conflict or constraint_violation rejects duplicate or inconsistent grants.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId"].map((name) => pathParameter(name, "uuid")),
    requestBody: body(createSchema),
    example: {
      body: { resource: "https://none.example", scopes: ["tutor:read"] },
    },
    responses: standardResponses(
      {},
      {
        201: { description: "Success", content: json(entitlementSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  getEntitlement: {
    method: "get",
    path: "/organizations/:organizationId/entitlements/:entitlementId",
    operationId: "getEntitlement",
    summary: "Get an organisation entitlement",
    description:
      "Return an organisation entitlement without changing state. Prefer listEntitlements to discover its id; validation_failed rejects malformed ids and not_found means the target is unavailable.",
    tag: "Entitlements",
    platformScope: "platform:read",
    kind: "read",
    parameters: ["organizationId", "entitlementId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(entitlementSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
  updateEntitlement: {
    method: "patch",
    path: "/organizations/:organizationId/entitlements/:entitlementId",
    operationId: "updateEntitlement",
    summary: "Update an organisation entitlement",
    description:
      "Change an entitlement’s scopes or validity window and return the updated entitlement, affecting subsequent access decisions. Prefer createEntitlement to select a different principal or target; validation_failed rejects invalid scopes or an empty patch, not_found means the entitlement is missing, and constraint_violation rejects an invalid window.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "entitlementId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    requestBody: body(patchSchema),
    example: { body: { scopes: ["tutor:read"] } },
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(entitlementSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  disableEntitlement: {
    method: "post",
    path: "/organizations/:organizationId/entitlements/:entitlementId/disable",
    operationId: "disableEntitlement",
    summary: "Disable an organisation entitlement",
    description:
      "Disable an organisation entitlement and return the updated record. Prefer enableEntitlement for the opposite transition; not_found means the target is missing and entitlement_already_disabled means no transition is needed.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "entitlementId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(entitlementSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  enableEntitlement: {
    method: "post",
    path: "/organizations/:organizationId/entitlements/:entitlementId/enable",
    operationId: "enableEntitlement",
    summary: "Enable an organisation entitlement",
    description:
      "Enable an organisation entitlement and return the updated record. Prefer disableEntitlement for the opposite transition; not_found means the target is missing and entitlement_already_active means no transition is needed.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "entitlementId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(entitlementSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  removeEntitlement: {
    method: "delete",
    path: "/organizations/:organizationId/entitlements/:entitlementId",
    operationId: "removeEntitlement",
    summary: "Remove an organisation entitlement",
    description:
      "Remove an organisation entitlement and return no content, removing access supplied by that record. Prefer updateEntitlement to change its validity or scopes; validation_failed rejects malformed ids and not_found means the target is unavailable.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "entitlementId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      {},
      { 204: { description: "Success" }, ...problemResponses(400, 404, 409) },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listEntitlements,
    validate("param", orgParams),
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await service.listEntitlements(
          context.get("db"),
          context.req.param("organizationId")!,
          query,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.createEntitlement,
    validate("param", orgParams),
    validate("json", createSchema),
    async (context) => {
      const input = createSchema.parse(await context.req.json());
      return context.json(
        await service.createEntitlement(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          { ...input, ...windowDates(input) },
        ),
        201,
      );
    },
  );
  registerRoute(
    app,
    routes.getEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      return context.json(
        await service.getEntitlement(
          context.get("db"),
          context.req.param("organizationId")!,
          context.req.param("entitlementId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.updateEntitlement,
    validate("param", entitlementParams),
    validate("json", patchSchema),
    async (context) => {
      const input = patchSchema.parse(await context.req.json());
      return context.json(
        await service.updateEntitlement(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("entitlementId")!,
          { ...input, ...windowDates(input) },
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.disableEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      return context.json(
        await service.disableEntitlement(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("entitlementId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.enableEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      return context.json(
        await service.enableEntitlement(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("entitlementId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.removeEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      await service.removeEntitlement(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        context.req.param("entitlementId")!,
      );
      return context.body(null, 204);
    },
  );
}
