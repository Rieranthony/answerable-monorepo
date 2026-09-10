import { platformRead } from "./platform-read.ts";
import { tenantRead } from "./tenant-read.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
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
import {
  platformCommand,
  operationJson,
  idempotencyParameter,
  commandResponseHeaders,
} from "./command.ts";
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
  revision: z.number().int().positive(),
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
const allQuerySchema = querySchema.omit({ memberId: true, groupId: true });
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
  listAllEntitlements: {
    method: "get",
    path: "/entitlements",
    operationId: "listAllEntitlements",
    summary: "List all entitlements",
    description:
      "Return entitlements across organisations with each organisation id and slug, newest first, without changing state. Filter by clientId, resource or status and continue with limit and cursor. Prefer listEntitlements for one organisation; validation_failed rejects invalid filters or cursors.",
    tag: "Entitlements",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Entitlements",
          content: json(
            page(
              entitlementSchema.extend({
                organization: z.object({ id: z.uuid(), slug: z.string() }),
              }),
            ),
          ),
        },
        ...problemResponses(400),
      },
    ),
  },
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
    freshAuthentication: false,
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
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects. Live changed-input reuse conflicts and expired recovery never re-executes. Create an organisation, group or member entitlement to a client, resource or exact client/resource pair and return the entitlement, granting access during its validity window. Prefer updateEntitlement to change existing scopes or dates; validation_failed rejects invalid targets or scopes, not_found means a referenced parent or target is missing, and conflict or constraint_violation rejects duplicate or inconsistent grants.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [pathParameter("organizationId", "uuid"), idempotencyParameter],
    requestBody: body(createSchema),
    example: {
      body: { resource: "https://none.example", scopes: ["tutor:read"] },
    },
    responses: standardResponses(
      {},
      {
        201: {
          description: "Success",
          headers: commandResponseHeaders,
          content: json(entitlementSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
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
    freshAuthentication: false,
    parameters: ["organizationId", "entitlementId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "Success",
          headers: revisionResponseHeaders,
          content: json(entitlementSchema),
        },
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
      "Requires Idempotency-Key and the strong If-Match ETag from getEntitlement. Missing conditions return 428; stale or wrong-instance state returns 412. Committed replay precedes the old revision check. Identical authorised retries recover the original result for seven days without repeating effects. Live changed-input reuse conflicts and expired recovery never re-executes. Change an entitlement’s scopes or validity window and return the updated entitlement, affecting subsequent access decisions. Prefer createEntitlement to select a different principal or target; validation_failed rejects invalid scopes or an empty patch, not_found means the entitlement is missing, and constraint_violation rejects an invalid window. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "entitlementId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
      revisionParameter,
    ],
    requestBody: body(patchSchema),
    example: { body: { scopes: ["tutor:read"] } },
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          content: json(entitlementSchema),
        },
        ...problemResponses(400, 404, 409, 410, 412, 428, 503),
      },
    ),
  },
  disableEntitlement: {
    method: "post",
    path: "/organizations/:organizationId/entitlements/:entitlementId/disable",
    operationId: "disableEntitlement",
    summary: "Disable an organisation entitlement",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects. Live changed-input reuse conflicts and expired recovery never re-executes. Disable an organisation entitlement and return the updated record. Prefer enableEntitlement for the opposite transition; not_found means the target is missing and unchanged status records a noop without updating timestamps. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "entitlementId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
    ],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: commandResponseHeaders,
          content: json(entitlementSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  enableEntitlement: {
    method: "post",
    path: "/organizations/:organizationId/entitlements/:entitlementId/enable",
    operationId: "enableEntitlement",
    summary: "Enable an organisation entitlement",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects. Live changed-input reuse conflicts and expired recovery never re-executes. Enable an organisation entitlement and return the updated record. Prefer disableEntitlement for the opposite transition; not_found means the target is missing and unchanged status records a noop without updating timestamps.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "entitlementId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
    ],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: commandResponseHeaders,
          content: json(entitlementSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  removeEntitlement: {
    method: "delete",
    path: "/organizations/:organizationId/entitlements/:entitlementId",
    operationId: "removeEntitlement",
    summary: "Remove an organisation entitlement",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects. Live changed-input reuse conflicts and expired recovery never re-executes. Soft-delete an organisation entitlement and return no content, removing access supplied by that record. Deletion is terminal; an explicit replacement gets a new UUID. Prefer updateEntitlement to change its validity or scopes; validation_failed rejects malformed ids and not_found means the target is unavailable. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input.",
    tag: "Entitlements",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "entitlementId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
    ],
    responses: standardResponses(
      {},
      {
        204: { description: "Success", headers: commandResponseHeaders },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listAllEntitlements,
    validate("query", allQuerySchema),
    async (context) =>
      context.json(
        await platformRead(context, (platform) =>
          service.listAllEntitlements(
            platform,
            allQuerySchema.parse(context.req.query()),
          ),
        ),
      ),
  );
  registerRoute(
    app,
    routes.listEntitlements,
    validate("param", orgParams),
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await tenantRead(context, "directory", (tenant) =>
          service.listEntitlements(tenant, query),
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
      const organizationId = context.req.param("organizationId")!;
      const parsed = createSchema.parse(await context.req.json());
      const input = {
        ...parsed,
        ...windowDates(parsed),
        ...(parsed.scopes === undefined
          ? {}
          : { scopes: [...new Set(parsed.scopes)].sort() }),
      };
      return platformCommand(
        context,
        "createEntitlement",
        operationJson({ organizationId, input }),
        201,
        async (platform) => {
          const row = await service.createEntitlement(
            platform,
            organizationId,
            input,
          );
          return {
            body: row,
            resultReference: { type: "entitlement", id: row.id },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.getEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      const result = await tenantRead(context, "directory", (tenant) =>
        service.getEntitlement(tenant, context.req.param("entitlementId")!),
      );
      context.header("ETag", revisionTag(result));
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.updateEntitlement,
    validate("param", entitlementParams),
    validate("json", patchSchema),
    async (context) => {
      const expected = requireRevision(context.req.header("If-Match"));
      const organizationId = context.req.param("organizationId")!;
      const entitlementId = context.req.param("entitlementId")!;
      const parsed = patchSchema.parse(await context.req.json());
      const input = {
        ...parsed,
        ...windowDates(parsed),
        ...(parsed.scopes === undefined
          ? {}
          : { scopes: [...new Set(parsed.scopes)].sort() }),
      };
      return platformCommand(
        context,
        "updateEntitlement",
        operationJson({ organizationId, entitlementId, expected, input }),
        200,
        async (platform) => {
          const result = await service.updateEntitlement(
            platform,
            organizationId,
            entitlementId,
            input,
            expected,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "entitlement", id: entitlementId },
          };
        },
        {
          retention: "ordinary",
          etag: (body) =>
            revisionTag(
              entitlementSchema.pick({ id: true, revision: true }).parse(body),
            ),
        },
      );
    },
  );
  registerRoute(
    app,
    routes.disableEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const entitlementId = context.req.param("entitlementId")!;
      return platformCommand(
        context,
        "disableEntitlement",
        operationJson({ organizationId, entitlementId }),
        200,
        async (platform) => {
          const result = await service.disableEntitlement(
            platform,
            organizationId,
            entitlementId,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "entitlement", id: entitlementId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.enableEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const entitlementId = context.req.param("entitlementId")!;
      return platformCommand(
        context,
        "enableEntitlement",
        operationJson({ organizationId, entitlementId }),
        200,
        async (platform) => {
          const result = await service.enableEntitlement(
            platform,
            organizationId,
            entitlementId,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "entitlement", id: entitlementId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.removeEntitlement,
    validate("param", entitlementParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const entitlementId = context.req.param("entitlementId")!;
      return platformCommand(
        context,
        "removeEntitlement",
        operationJson({ organizationId, entitlementId }),
        204,
        async (platform) => {
          await service.removeEntitlement(
            platform,
            organizationId,
            entitlementId,
          );
          return {
            body: null,
            resultReference: { type: "entitlement", id: entitlementId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
}
