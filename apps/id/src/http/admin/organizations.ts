import { commandJson } from "./schemas.ts";
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
  confirmQuery,
} from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
import {
  platformCommand,
  idempotencyParameter,
  commandResponseHeaders,
} from "./command.ts";
import * as service from "../../services/organizations.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";

export const organizationSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.string().nullable(),
  status: z.enum(lifecycleStatuses),
  authorizationVersion: z.number().int().positive(),
  disabledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const querySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(lifecycleStatuses).optional(),
});
const name = z.string().min(1).max(200);
const createSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name,
  logo: z.url().optional(),
  metadata: z.string().max(4000).optional(),
});
const patchSchema = z
  .object({
    name: name.optional(),
    logo: z.url().nullable().optional(),
    metadata: z.string().max(4000).nullable().optional(),
  })
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "At least one field is required",
  );
const eraseSchema = uuidParam("confirm");
const paramSchema = uuidParam("organizationId");
const parameters = [
  pathParameter("organizationId", "uuid"),
] satisfies AdminRoute["parameters"];
const success = {
  200: { description: "Organisation", content: json(organizationSchema) },
};

export const routes = {
  listOrganizations: {
    method: "get",
    path: "/organizations",
    operationId: "listOrganizations",
    summary: "List organisations",
    description:
      "Return a cursor page of organisations, without changing state. Prefer getOrganization for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors.",
    tag: "Organizations",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Organisations",
          content: json(
            z.object({
              items: z.array(organizationSchema),
              nextCursor: z.uuid().nullable(),
            }),
          ),
        },
        ...problemResponses(400),
      },
    ),
  },
  createOrganization: {
    method: "post",
    path: "/organizations",
    operationId: "createOrganization",
    summary: "Create an organisation",
    description:
      "Requires Idempotency-Key. Identical authorised retries return the receipt; changed input conflicts. Create an organisation and return its generated id and stored fields, recording the creation in the audit log. Prefer updateOrganization when its id already exists; validation_failed rejects malformed input and conflict means the slug is already in use.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [idempotencyParameter],
    requestBody: body(createSchema),
    example: { body: { slug: "acme", name: "Acme" } },
    responses: standardResponses(
      {},
      {
        201: {
          description: "Organisation created",
          content: commandJson(organizationSchema),
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 409, 503),
      },
    ),
  },
  getOrganization: {
    method: "get",
    path: "/organizations/:organizationId",
    operationId: "getOrganization",
    summary: "Get an organisation",
    description:
      "Return an organisation without changing state. Prefer listOrganizations to discover its id; validation_failed rejects malformed ids and not_found means the target is unavailable.",
    tag: "Organizations",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    parameters,
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { ...success[200], headers: revisionResponseHeaders },
        ...problemResponses(400),
      },
    ),
  },
  updateOrganization: {
    method: "patch",
    path: "/organizations/:organizationId",
    operationId: "updateOrganization",
    summary: "Update an organisation",
    description:
      "Requires Idempotency-Key and optionally the If-Match ETag from getOrganization. Stale supplied revisions return 412. Committed replay precedes its old revision check. An unchanged patch preserves the revision. Identical authorised retries return the receipt; changed input conflicts. Update an organisation and return the updated record, recording the change in the audit log. Prefer getOrganization to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: false,
    parameters: [...parameters, idempotencyParameter, revisionParameter],
    requestBody: body(patchSchema),
    example: { body: { name: "Acme Ltd" } },
    responses: standardResponses(
      {},
      {
        200: {
          ...success[200],
          content: commandJson(organizationSchema),
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
        },
        ...problemResponses(400, 404, 409, 412, 503),
      },
    ),
  },
  disableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/disable",
    operationId: "disableOrganization",
    summary: "Disable an organisation",
    description:
      "Requires Idempotency-Key. Identical authorised retries return the receipt; changed input conflicts. Disable the organisation, advance its authorizationVersion, revoke stored machine access tokens for its owned clients, and return the updated organisation. Global browser sessions and unbound user tokens are preserved; client ownership does not establish a user grant’s tenant. Complete tenant user-grant revocation is not yet implemented. Prefer enableOrganization to allow future access without restoring revoked credentials; validation_failed rejects malformed ids, not_found means the organisation is missing, and already disabled state returns a noop without another epoch advance.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          ...success[200],
          content: commandJson(organizationSchema),
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 404, 409, 503),
      },
    ),
  },
  enableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/enable",
    operationId: "enableOrganization",
    summary: "Enable an organisation",
    description:
      "Requires Idempotency-Key. Identical authorised retries return the receipt; changed input conflicts. Enable an organisation and return the updated record. Its authorizationVersion stays advanced, so pre-disable machine tokens remain invalid at the admin API; obtain fresh tokens. Prefer disableOrganization for the opposite transition; not_found means the target is missing and already active state returns a noop.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          ...success[200],
          content: commandJson(organizationSchema),
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 404, 409, 503),
      },
    ),
  },
  eraseOrganization: {
    method: "delete",
    path: "/organizations/:organizationId",
    operationId: "eraseOrganization",
    summary: "Erase an organisation",
    description:
      "Requires Idempotency-Key. Identical authorised retries return the receipt; changed input conflicts. Soft-delete the organisation and its tenant configuration, memberships and assignments. Clear provider credentials, revoke tenant grant contexts and clear browser-session selections. Global profiles and sessions remain. organization_has_clients requires removing owned clients first; undeleted owned resources also block deletion. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableOrganization for reversible offboarding. Product deletion retains rows with terminal deletedAt markers; identifying data can remain. Ordinary reads and authority exclude deleted rows. Enabling cannot restore them. Physical cleanup and its retention period are deferred.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "erase",
    freshAuthentication: true,
    parameters: [
      ...parameters,
      confirmQuery(eraseSchema.shape.confirm),
      idempotencyParameter,
    ],
    example: { query: { confirm: "00000000-0000-7000-8000-000000000000" } },
    responses: standardResponses(
      {},
      {
        204: {
          description: "Organisation erased",
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
    routes.listOrganizations,
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await platformRead(context, (platform) =>
          service.listOrganizations(platform, query),
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.createOrganization,
    validate("json", createSchema),
    async (context) => {
      const input = createSchema.parse(await context.req.json());
      return platformCommand(
        context,
        "createOrganization",
        input,
        201,
        async (platform) => {
          const body = await service.createOrganization(platform, input);
          return {
            body,
            resultReference: { type: "organization", id: body.id },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.getOrganization,
    validate("param", paramSchema),
    async (context) => {
      const result = await tenantRead(
        context,
        "directory",
        service.getOrganization,
      );
      context.header("ETag", revisionTag(result));
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.updateOrganization,
    validate("param", paramSchema),
    validate("json", patchSchema),
    async (context) => {
      const patch = patchSchema.parse(await context.req.json());
      const expected = requireRevision(context.req.header("If-Match"));
      const organizationId = context.req.param("organizationId")!;
      return platformCommand(
        context,
        "updateOrganization",
        { organizationId, ...(expected ? { expected } : {}), patch },
        200,
        async (platform) => {
          const result = await service.updateOrganization(
            platform,
            organizationId,
            patch,
            expected,
          );
          return {
            body: result.organization,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "organization", id: organizationId },
          };
        },
        {
          etag: (body) =>
            revisionTag(
              organizationSchema.pick({ id: true, revision: true }).parse(body),
            ),
        },
      );
    },
  );
  registerRoute(
    app,
    routes.disableOrganization,
    validate("param", paramSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      return platformCommand(
        context,
        "disableOrganization",
        { organizationId },
        200,
        async (platform) => {
          const result = await service.disableOrganization(
            platform,
            organizationId,
          );
          return {
            body: result.organization,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "organization", id: organizationId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.enableOrganization,
    validate("param", paramSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      return platformCommand(
        context,
        "enableOrganization",
        { organizationId },
        200,
        async (platform) => {
          const result = await service.enableOrganization(
            platform,
            organizationId,
          );
          return {
            body: result.organization,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "organization", id: organizationId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.eraseOrganization,
    validate("param", paramSchema),
    validate("query", eraseSchema),
    async (context) => {
      const { confirm } = eraseSchema.parse(context.req.query());
      const organizationId = context.req.param("organizationId")!;
      return platformCommand(
        context,
        "eraseOrganization",
        { organizationId, confirm },
        204,
        async (platform) => {
          await service.eraseOrganization(platform, organizationId, confirm);
          return {
            body: null,
            resultReference: { type: "organization", id: organizationId },
          };
        },
      );
    },
  );
}
