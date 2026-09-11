import { commandJson } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import * as service from "../../services/capabilities.ts";
import { capabilityGrantKinds } from "../../db/schema/capabilities.ts";
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
import {
  body,
  json,
  pathParameter,
  uuidParam,
  windowDates,
  windowSchema,
} from "./schemas.ts";
import {
  platformCommand,
  operationJson,
  idempotencyParameter,
  commandResponseHeaders,
} from "./command.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import { tenantRead } from "./tenant-read.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { standardResponses } from "./openapi.ts";

const orgParams = uuidParam("organizationId");
const params = orgParams.extend({ capabilityId: z.uuid() });
const scopes = z.array(z.string().min(1)).min(1);
export const capabilitySchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  clientId: z.string().nullable(),
  resource: z.url().nullable(),
  grantKind: z.enum(capabilityGrantKinds),
  scopes,
  status: z.enum(lifecycleStatuses),
  validFrom: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const createSchema = z.discriminatedUnion("grantKind", [
  windowSchema
    .extend({
      clientId: z.string().min(1),
      resource: z.url().nullable().default(null),
      grantKind: z.literal("authorization_code"),
      scopes,
    })
    .strict(),
  windowSchema
    .extend({
      clientId: z.string().min(1),
      resource: z.url().nullable().default(null),
      grantKind: z.literal("refresh_token"),
      scopes,
    })
    .strict(),
  windowSchema
    .extend({
      clientId: z.string().min(1),
      resource: z.url(),
      grantKind: z.literal("client_credentials"),
      scopes,
    })
    .strict(),
  windowSchema
    .extend({
      clientId: z.null().default(null),
      resource: z.url(),
      grantKind: z.literal("admin_session"),
      scopes,
    })
    .strict(),
]);
const patchSchema = windowSchema
  .extend({
    scopes: scopes.optional(),
    status: z.enum(lifecycleStatuses).optional(),
  })
  .strict()
  .refine(
    (input) => Object.keys(input).length > 0,
    "At least one field is required",
  );
const orgParameter = pathParameter("organizationId", "uuid");
const idParameter = pathParameter("capabilityId", "uuid");
const recovery =
  "Requires Idempotency-Key. Identical authorised retries return the receipt; changed input returns idempotency_key_reused. ";
export const routes = {
  listCapabilities: {
    method: "get",
    path: "/organizations/:organizationId/capabilities",
    operationId: "listCapabilities",
    summary: "List organisation capability ceilings",
    description:
      "Read a cursor page of platform-approved ceilings for this organisation without changing state. This is configuration, not proof of a successful token grant. Machine and direct-session ceilings are enforced. User ceilings are administrable and enforced in the native integration proof; public user OAuth remains closed. validation_failed means an invalid parameter; not_found means the organisation is unavailable.",
    tag: "Capabilities",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    parameters: [orgParameter],
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "Capabilities",
          content: json(
            z.object({
              items: z.array(capabilitySchema),
              nextCursor: z.uuid().nullable(),
            }),
          ),
        },
        ...problemResponses(400, 404),
      },
    ),
  },
  getCapability: {
    method: "get",
    path: "/organizations/:organizationId/capabilities/:capabilityId",
    operationId: "getCapability",
    summary: "Get an organisation capability ceiling",
    description:
      "Read stored capability configuration and its strong ETag without changing state. Prefer listCapabilities to discover ids. validation_failed means a malformed id; not_found means the capability is unavailable in this organisation.",
    tag: "Capabilities",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    parameters: [orgParameter, idParameter],
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "Capability",
          headers: revisionResponseHeaders,
          content: json(capabilitySchema),
        },
        ...problemResponses(400, 404),
      },
    ),
  },
  createCapability: {
    method: "post",
    path: "/organizations/:organizationId/capabilities",
    operationId: "createCapability",
    summary: "Approve an organisation capability",
    description:
      recovery +
      "Approve an exact client/resource pair for client_credentials in its immutable owner organisation. Registration and compatibility alone grant no machine permission. Only platform writers may approve ceilings. For direct session administration, use admin_session with a null clientId and the bound ID admin resource. Only the platform organisation may receive platform scopes. For user grants use authorization_code: null resource approves login identity scopes, an exact resource approves resource scopes. refresh_token approves renewal separately for a client-only login or exact resource pair. User scopes must fit the registered client scopes and resource vocabulary; identity and resource scopes cannot be mixed. User clients may serve multiple organisations, while private resources must belong to the approved organisation. Capabilities approve ceilings; current membership, authentication, assignments and consent are also required. Prefer updateCapability for scopes, windows or status. validation_failed rejects incompatible targets/scopes; not_found means a reference is missing; conflict or constraint_violation means duplicate or inconsistent configuration.",
    tag: "Capabilities",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [orgParameter, idempotencyParameter],
    requestBody: body(createSchema),
    example: {
      body: {
        clientId: "machine",
        resource: "https://api.example",
        grantKind: "client_credentials",
        scopes: ["tool:read"],
      },
    },
    responses: standardResponses(
      {},
      {
        201: {
          description: "Created capability",
          headers: commandResponseHeaders,
          content: commandJson(capabilitySchema),
        },
        ...problemResponses(400, 404, 409, 503),
      },
    ),
  },
  updateCapability: {
    method: "patch",
    path: "/organizations/:organizationId/capabilities/:capabilityId",
    operationId: "updateCapability",
    summary: "Update an organisation capability",
    description:
      recovery +
      "Accepts the strong If-Match ETag from getCapability; stale returns 412. Committed replay precedes that check. Change scopes, effective windows or active/disabled status; unchanged configuration records a noop. Disabling prevents subsequent machine grants and removes authority supplied by direct-session assignments, but does not revoke already-issued offline JWTs. Assignments remain. Tenant and target are immutable. validation_failed rejects unsupported fields, grant kinds or scopes; not_found means the capability is missing; constraint_violation rejects inconsistent windows.",
    tag: "Capabilities",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      orgParameter,
      idParameter,
      idempotencyParameter,
      revisionParameter,
    ],
    requestBody: body(patchSchema),
    example: { body: { status: "disabled" } },
    responses: standardResponses(
      {},
      {
        200: {
          description: "Capability",
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          content: commandJson(capabilitySchema),
        },
        ...problemResponses(400, 404, 409, 412, 503),
      },
    ),
  },
  removeCapability: {
    method: "delete",
    path: "/organizations/:organizationId/capabilities/:capabilityId",
    operationId: "removeCapability",
    summary: "Remove an organisation capability",
    description:
      recovery +
      "Soft-delete a user, machine or tenant direct-session capability, retaining its disabled row and before/after audit state. Deletion is terminal; an explicit replacement gets a new UUID. Subsequent grants are denied; existing offline tokens remain bounded by expiry. Assignments remain. Remove references before erasing a client or resource. Prefer updateCapability with disabled status for a reversible suspension. validation_failed rejects malformed input; not_found means the capability is unavailable.",
    tag: "Capabilities",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [orgParameter, idParameter, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        204: {
          description: "Removed capability",
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 404, 409, 503),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listCapabilities,
    validate("param", orgParams),
    validate("query", pageQuerySchema),
    async (context) =>
      context.json(
        await tenantRead(context, "directory", (tenant) =>
          service.listCapabilities(
            tenant,
            pageQuerySchema.parse(context.req.query()),
          ),
        ),
      ),
  );
  registerRoute(
    app,
    routes.getCapability,
    validate("param", params),
    async (context) => {
      const row = await tenantRead(context, "directory", (tenant) =>
        service.getCapability(tenant, context.req.param("capabilityId")!),
      );
      context.header("ETag", revisionTag(row));
      return context.json(row);
    },
  );
  registerRoute(
    app,
    routes.createCapability,
    validate("param", orgParams),
    validate("json", createSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const parsed = createSchema.parse(await context.req.json());
      const input = {
        ...parsed,
        ...windowDates({
          validFrom: parsed.validFrom ?? null,
          validUntil: parsed.validUntil ?? null,
        }),
        scopes: [...new Set(parsed.scopes)].sort(),
      };
      return platformCommand(
        context,
        "createCapability",
        operationJson({ organizationId, input }),
        201,
        async (platform) => {
          const row = await service.createCapability(
            platform,
            organizationId,
            input,
          );
          return {
            body: row,
            resultReference: { type: "capability", id: row.id },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.updateCapability,
    validate("param", params),
    validate("json", patchSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const capabilityId = context.req.param("capabilityId")!;
      const expected = requireRevision(context.req.header("If-Match"));
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
        "updateCapability",
        operationJson({ organizationId, capabilityId, expected, input }),
        200,
        async (platform) => {
          const result = await service.updateCapability(
            platform,
            organizationId,
            capabilityId,
            input,
            expected,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "capability", id: capabilityId },
          };
        },
        {
          etag: (value) =>
            revisionTag(
              capabilitySchema.pick({ id: true, revision: true }).parse(value),
            ),
        },
      );
    },
  );
  registerRoute(
    app,
    routes.removeCapability,
    validate("param", params),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const capabilityId = context.req.param("capabilityId")!;
      return platformCommand(
        context,
        "removeCapability",
        operationJson({ organizationId, capabilityId }),
        204,
        async (platform) => {
          await service.removeCapability(
            platform,
            organizationId,
            capabilityId,
          );
          return {
            body: null,
            resultReference: { type: "capability", id: capabilityId },
          };
        },
      );
    },
  );
}
