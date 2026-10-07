import {
  commandJson,
  json,
  body,
  pathParameter,
  confirmQuery,
  softDeletion,
  pageSchema,
} from "./schemas.ts";
import { platformRead } from "./platform-read.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { platformCommand } from "./command.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import * as service from "../../services/resources.ts";
import { resourceClassifications } from "../../db/schema/vocabulary.ts";
import type { AppEnvironment } from "../context.ts";
import { uniqueSorted } from "../../lib/scopes.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
const resourceSchema = z.object({
  classification: z.enum(resourceClassifications),
  organizationId: z.uuid().nullable(),
  id: z.uuid(),
  identifier: z.url(),
  name: z.string(),
  accessTokenTtl: z.number().nullable(),
  refreshTokenTtl: z.number().nullable(),
  signingAlgorithm: z.string().nullable(),
  allowedScopes: z.array(z.string()).nullable(),
  disabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const fields = {
  name: z.string().min(1).max(200),
  accessTokenTtl: z.number().int().min(60).max(3600).optional(),
  refreshTokenTtl: z.number().int().min(60).optional(),
  allowedScopes: z.array(z.string().min(1)).min(1),
};
const createSchema = z
  .object({
    classification: z.enum(resourceClassifications).default("platform_shared"),
    organizationId: z.uuid().nullable().default(null),
    identifier: z.url(),
    ...fields,
    signingAlgorithm: z.enum(["EdDSA", "ES256", "RS256"]).optional(),
  })
  .refine(
    (input) =>
      (input.classification === "tenant_owned") ===
      (input.organizationId !== null),
    {
      path: ["organizationId"],
      message:
        "Tenant-owned resources require an owner; platform-shared resources cannot have one",
    },
  );
const patchSchema = z
  .object(fields)
  .strict()
  .partial()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "At least one field is required",
  );
const eraseSchema = z.object({ confirm: z.url() });
const querySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  disabled: z.enum(["true", "false"]).optional(),
});
const paramSchema = z.object({ resource: z.url() });
const parameters = [
  pathParameter("resource", "uri"),
] satisfies AdminRoute["parameters"];

export const routes = {
  listResources: {
    method: "get",
    path: "/resources",
    operationId: "listResources",
    summary: "List resources",
    description:
      "Return a cursor page of resources, without changing state. Prefer getResource for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors.",
    tag: "Resources",
    platformScope: "platform:read",
    kind: "read",
    responses: {
      200: {
        description: "Resources",
        content: json(pageSchema(resourceSchema)),
      },
      ...problemResponses(400),
    },
  },
  createResource: {
    method: "post",
    path: "/resources",
    operationId: "createResource",
    summary: "Create resource",
    description:
      "Create an OAuth resource and return its generated id, URL identifier and configuration, recording the creation in the audit log. Prefer updateResource for an existing URL identifier; validation_failed rejects malformed input conflict means the identifier already exists including retired identifiers.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    requestBody: body(createSchema),
    example: {
      body: {
        identifier: "https://mcp.example.com",
        name: "Example MCP",
        allowedScopes: ["tutor:read"],
      },
    },
    responses: {
      201: {
        description: "Resource created",
        content: commandJson(resourceSchema),
      },
      ...problemResponses(404),
    },
  },
  getResource: {
    method: "get",
    path: "/resources/:resource",
    operationId: "getResource",
    summary: "Get resource (URL-encode {resource})",
    description:
      "Return the OAuth resource configuration without changing state. The {resource} URL must be percent-encoded in the path; prefer listResources to discover its identifier, and validation_failed or not_found identifies malformed input or a missing resource.",
    tag: "Resources",
    platformScope: "platform:read",
    kind: "read",
    parameters,
    responses: {
      200: {
        headers: revisionResponseHeaders,
        description: "Resource",
        content: json(resourceSchema.extend({ clients: z.array(z.string()) })),
      },
      ...problemResponses(400, 404, 409),
    },
  },
  updateResource: {
    method: "patch",
    path: "/resources/:resource",
    operationId: "updateResource",
    summary: "Update resource (URL-encode {resource})",
    description:
      "Accepts the If-Match ETag from getResource. Stale supplied revisions return 412; committed replay precedes the old revision check. An unchanged patch records noop without advancing the revision. Change the resource configuration and return the updated record, recording the change in the audit log. The {resource} URL must be percent-encoded in the path; prefer getResource to inspect settings, and validation_failed or not_found identifies malformed input or a missing resource.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: { unlessOnly: ["name"] },
    parameters: [...parameters, revisionParameter],
    requestBody: body(patchSchema),
    example: { body: { name: "Renamed" } },
    responses: {
      200: {
        headers: revisionResponseHeaders,
        description: "Resource updated",
        content: commandJson(resourceSchema),
      },
      ...problemResponses(404, 412),
    },
  },
  disableResource: {
    method: "post",
    path: "/resources/:resource/disable",
    operationId: "disableResource",
    summary: "Disable resource (URL-encode {resource})",
    description:
      "Disable the resource for future token grants, revoke its stored grant contexts across tenants and return its updated configuration. The {resource} URL must be percent-encoded in the path; prefer enableResource to restore use, and validation_failed, not_found or resource_protected identifies malformed input, a missing resource or the protected admin resource. An already disabled resource reconciles remaining unrevoked contexts; it returns 200 with a noop outcome only when neither state nor contexts change. Protection follows the persisted system resource UUID, not a configured name.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    responses: {
      200: {
        description: "Resource disabled",
        content: commandJson(resourceSchema),
      },
      ...problemResponses(404),
    },
  },
  enableResource: {
    method: "post",
    path: "/resources/:resource/enable",
    operationId: "enableResource",
    summary: "Enable resource (URL-encode {resource})",
    description:
      "Enable resource and return the updated record without restoring previously revoked grant contexts. Prefer disableResource for the opposite transition; not_found means the target is missing and an already active resource returns 200 with a noop outcome; the {resource} URL must be percent-encoded in the path.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    responses: {
      200: {
        description: "Resource enabled",
        content: commandJson(resourceSchema),
      },
      ...problemResponses(404),
    },
  },
  eraseResource: {
    method: "delete",
    path: "/resources/:resource",
    operationId: "eraseResource",
    summary: "Erase resource (URL-encode {resource})",
    description: `capability_references_exist requires removing all referencing capabilities before erasure. Soft-delete the resource and return no content; resource_has_entitlements requires removing entitlements first; resource_has_clients requires explicitly unlinking all clients before erasure; resource_protected prevents erasing the admin resource. The confirm query parameter must equal the target id; the {resource} URL must be percent-encoded in the path, and confirm is the decoded resource identifier. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableResource for reversible suspension. Protection follows the persisted system resource UUID, not a configured name. ${softDeletion}`,
    tag: "Resources",
    platformScope: "platform:write",
    kind: "erase",
    freshAuthentication: true,
    parameters: [...parameters, confirmQuery(eraseSchema.shape.confirm)],
    example: { query: { confirm: "https://none.example" } },
    responses: {
      204: {
        description: "Resource erased",
      },
      ...problemResponses(404),
    },
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listResources,
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await platformRead(context, (platform) =>
          service.listResources(platform, {
            ...query,
            disabled:
              query.disabled === undefined
                ? undefined
                : query.disabled === "true",
          }),
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.createResource,
    validate("json", createSchema),
    async (context) => {
      const parsed = createSchema.parse(await context.req.json());
      const input = {
        ...parsed,
        allowedScopes: uniqueSorted(parsed.allowedScopes),
      };
      return platformCommand(
        context,
        "write",
        input,
        201,
        async (platform) => ({
          body: await service.createResource(platform, input),
          resultReference: { type: "resource", id: input.identifier },
        }),
      );
    },
  );
  registerRoute(
    app,
    routes.getResource,
    validate("param", paramSchema),
    async (context) => {
      const result = await platformRead(context, (platform) =>
        service.getResource(platform, context.req.param("resource")!),
      );
      context.header("ETag", revisionTag(result));
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.updateResource,
    validate("param", paramSchema),
    validate("json", patchSchema),
    async (context) => {
      const input = patchSchema.parse(await context.req.json());
      if (input.allowedScopes)
        input.allowedScopes = uniqueSorted(input.allowedScopes);
      const expected = requireRevision(context.req.header("If-Match"));
      const identifier = context.req.param("resource")!;
      return platformCommand(
        context,
        "write",
        { identifier, expected, patch: input },
        200,
        async (platform) => {
          const { row, changed } = await service.updateResource(
            platform,
            identifier,
            input,
            expected,
          );
          return {
            body: row,
            changed,
            resultReference: { type: "resource", id: identifier },
          };
        },
        { etag: true },
      );
    },
  );
  registerRoute(
    app,
    routes.disableResource,
    validate("param", paramSchema),
    async (context) => {
      const identifier = context.req.param("resource")!;
      return platformCommand(
        context,
        "write",
        { identifier },
        200,
        async (platform) => {
          const result = await service.disableResource(platform, identifier);
          return {
            body: result.row,
            changed: result.changed,
            resultReference: { type: "resource", id: identifier },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.enableResource,
    validate("param", paramSchema),
    async (context) => {
      const identifier = context.req.param("resource")!;
      return platformCommand(
        context,
        "write",
        { identifier },
        200,
        async (platform) => {
          const result = await service.enableResource(platform, identifier);
          return {
            body: result.row,
            changed: result.changed,
            resultReference: { type: "resource", id: identifier },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.eraseResource,
    validate("param", paramSchema),
    validate("query", eraseSchema),
    async (context) => {
      const input = eraseSchema.parse(context.req.query());
      const identifier = context.req.param("resource")!;
      return platformCommand(
        context,
        "write",
        { identifier, ...input },
        204,
        async (platform) => {
          await service.eraseResource(platform, identifier, input.confirm);
          return {
            body: null,
            resultReference: { type: "resource", id: identifier },
          };
        },
      );
    },
  );
}
