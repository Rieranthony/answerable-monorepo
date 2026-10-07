import {
  commandJson,
  json,
  body,
  pathParameter,
  uuidParam,
  confirmQuery,
  softDeletion,
  pageSchema,
} from "./schemas.ts";
import { platformRead } from "./platform-read.ts";
import { tenantRead } from "./tenant-read.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
import { platformCommand } from "./command.ts";
import * as service from "../../services/organizations.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";

const organizationSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  name: z.string(),
  slug: z.string(),
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
});
const patchSchema = z
  .object({
    name: name.optional(),
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
    responses: {
      200: {
        description: "Organisations",
        content: json(pageSchema(organizationSchema)),
      },
      ...problemResponses(400),
    },
  },
  createOrganization: {
    method: "post",
    path: "/organizations",
    operationId: "createOrganization",
    summary: "Create an organisation",
    description:
      "Create an organisation and return its generated id and stored fields, recording the creation in the audit log. Prefer updateOrganization when its id already exists; validation_failed rejects malformed input and conflict means the slug is already in use.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    requestBody: body(createSchema),
    example: { body: { slug: "acme", name: "Acme" } },
    responses: {
      201: {
        description: "Organisation created",
        content: commandJson(organizationSchema),
      },
    },
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
    parameters,
    responses: {
      200: { ...success[200], headers: revisionResponseHeaders },
      ...problemResponses(400),
    },
  },
  updateOrganization: {
    method: "patch",
    path: "/organizations/:organizationId",
    operationId: "updateOrganization",
    summary: "Update an organisation",
    description:
      "Accepts the If-Match ETag from getOrganization. Stale supplied revisions return 412. Committed replay precedes its old revision check. An unchanged patch preserves the revision. Update an organisation and return the updated record, recording the change in the audit log. Prefer getOrganization to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters: [...parameters, revisionParameter],
    requestBody: body(patchSchema),
    example: { body: { name: "Acme Ltd" } },
    responses: {
      200: {
        ...success[200],
        content: commandJson(organizationSchema),
        headers: revisionResponseHeaders,
      },
      ...problemResponses(404, 412),
    },
  },
  disableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/disable",
    operationId: "disableOrganization",
    summary: "Disable an organisation",
    description:
      "Disable the organisation, advance its authorizationVersion, revoke stored machine access tokens for its owned clients, and return the updated organisation. Global browser sessions and unbound user tokens are preserved; client ownership does not establish a user grant’s tenant. Complete tenant user-grant revocation is not yet implemented. Prefer enableOrganization to allow future access without restoring revoked credentials; validation_failed rejects malformed ids, not_found means the organisation is missing, and already disabled state returns a noop without another epoch advance.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    responses: {
      200: {
        ...success[200],
        content: commandJson(organizationSchema),
      },
      ...problemResponses(404),
    },
  },
  enableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/enable",
    operationId: "enableOrganization",
    summary: "Enable an organisation",
    description:
      "Enable an organisation and return the updated record. Its authorizationVersion stays advanced, so pre-disable machine tokens remain invalid at the admin API; obtain fresh tokens. Prefer disableOrganization for the opposite transition; not_found means the target is missing and already active state returns a noop.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    responses: {
      200: {
        ...success[200],
        content: commandJson(organizationSchema),
      },
      ...problemResponses(404),
    },
  },
  eraseOrganization: {
    method: "delete",
    path: "/organizations/:organizationId",
    operationId: "eraseOrganization",
    summary: "Erase an organisation",
    description: `Soft-delete the organisation and its tenant configuration, memberships and assignments. Clear provider credentials, revoke tenant grant contexts and clear browser-session selections. Global profiles and sessions remain. organization_has_clients requires removing owned clients first; undeleted owned resources also block deletion. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableOrganization for reversible offboarding. ${softDeletion}`,
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "erase",
    freshAuthentication: true,
    parameters: [...parameters, confirmQuery(eraseSchema.shape.confirm)],
    example: { query: { confirm: "00000000-0000-7000-8000-000000000000" } },
    responses: {
      204: {
        description: "Organisation erased",
      },
      ...problemResponses(404),
    },
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
      return platformCommand(context, "write", input, 201, async (platform) => {
        const body = await service.createOrganization(platform, input);
        return {
          body,
          resultReference: { type: "organization", id: body.id },
        };
      });
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
        "write",
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
            body: result.row,
            changed: result.changed,
            resultReference: { type: "organization", id: organizationId },
          };
        },
        { etag: true },
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
        "write",
        { organizationId },
        200,
        async (platform) => {
          const result = await service.disableOrganization(
            platform,
            organizationId,
          );
          return {
            body: result.row,
            changed: result.changed,
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
        "write",
        { organizationId },
        200,
        async (platform) => {
          const result = await service.enableOrganization(
            platform,
            organizationId,
          );
          return {
            body: result.row,
            changed: result.changed,
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
        "write",
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
