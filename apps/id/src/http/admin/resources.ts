import { json, body, pathParameter, confirmQuery } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
import * as service from "../../services/resources.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
export const resourceSchema = z.object({
  id: z.uuid(),
  identifier: z.url(),
  name: z.string(),
  accessTokenTtl: z.number().nullable(),
  refreshTokenTtl: z.number().nullable(),
  signingAlgorithm: z.string().nullable(),
  signingKeyId: z.string().nullable(),
  allowedScopes: z.array(z.string()).nullable(),
  customClaims: z.unknown().nullable(),
  dpopBoundAccessTokensRequired: z.boolean(),
  disabled: z.boolean(),
  policyVersion: z.number(),
  metadata: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const fields = {
  name: z.string().min(1).max(200),
  accessTokenTtl: z.number().int().min(60).max(3600).optional(),
  refreshTokenTtl: z.number().int().min(60).optional(),
  allowedScopes: z.array(z.string().min(1)).min(1),
};
const createSchema = z.object({
  identifier: z.url(),
  ...fields,
  signingAlgorithm: z.enum(["EdDSA", "ES256", "RS256"]).optional(),
});
const patchSchema = z
  .object(fields)
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
    responses: standardResponses(
      {},
      {
        200: {
          description: "Resources",
          content: json(
            z.object({
              items: z.array(resourceSchema),
              nextCursor: z.uuid().nullable(),
            }),
          ),
        },
        ...problemResponses(400),
      },
    ),
  },
  createResource: {
    method: "post",
    path: "/resources",
    operationId: "createResource",
    summary: "Create resource",
    description:
      "Create an OAuth resource and return its generated id, URL identifier and configuration, recording the creation in the audit log. Prefer updateResource for an existing URL identifier; validation_failed rejects malformed input and conflict means the identifier already exists.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    requestBody: body(createSchema),
    example: {
      body: {
        identifier: "https://mcp.example.com",
        name: "Example MCP",
        allowedScopes: ["tutor:read"],
      },
    },
    responses: standardResponses(
      {},
      {
        201: { description: "Resource created", content: json(resourceSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
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
    responses: standardResponses(
      {},
      {
        200: { description: "Resource", content: json(resourceSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  updateResource: {
    method: "patch",
    path: "/resources/:resource",
    operationId: "updateResource",
    summary: "Update resource (URL-encode {resource})",
    description:
      "Change the resource configuration and return the updated record, recording the change in the audit log. The {resource} URL must be percent-encoded in the path; prefer getResource to inspect settings, and validation_failed or not_found identifies malformed input or a missing resource.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    requestBody: body(patchSchema),
    example: { body: { name: "Renamed" } },
    responses: standardResponses(
      {},
      {
        200: { description: "Resource updated", content: json(resourceSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  disableResource: {
    method: "post",
    path: "/resources/:resource/disable",
    operationId: "disableResource",
    summary: "Disable resource (URL-encode {resource})",
    description:
      "Disable the resource for future token grants and return its updated configuration. The {resource} URL must be percent-encoded in the path; prefer enableResource to restore use, and validation_failed, not_found, resource_already_disabled or resource_protected identifies malformed input, a missing resource, an unchanged state or the protected admin resource.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Resource disabled",
          content: json(resourceSchema),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  enableResource: {
    method: "post",
    path: "/resources/:resource/enable",
    operationId: "enableResource",
    summary: "Enable resource (URL-encode {resource})",
    description:
      "Enable resource and return the updated record. Prefer disableResource for the opposite transition; not_found means the target is missing and resource_already_active means no transition is needed; the {resource} URL must be percent-encoded in the path.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      {
        200: { description: "Resource enabled", content: json(resourceSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  eraseResource: {
    method: "delete",
    path: "/resources/:resource",
    operationId: "eraseResource",
    summary: "Erase resource (URL-encode {resource})",
    description:
      "Permanently erase the resource and return no content; resource_has_entitlements requires removing entitlements first; resource_protected prevents erasing the admin resource. The confirm query parameter must equal the target id; the {resource} URL must be percent-encoded in the path, and confirm is the decoded resource identifier. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableResource for reversible offboarding.",
    tag: "Resources",
    platformScope: "platform:write",
    kind: "erase",
    parameters: [...parameters, confirmQuery(eraseSchema.shape.confirm)],
    example: { query: { confirm: "https://none.example" } },
    responses: standardResponses(
      {},
      {
        204: { description: "Resource erased" },
        ...problemResponses(400, 404, 409),
      },
    ),
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
        await service.listResources(context.get("db"), {
          ...query,
          disabled:
            query.disabled === undefined
              ? undefined
              : query.disabled === "true",
        }),
      );
    },
  );
  registerRoute(
    app,
    routes.createResource,
    validate("json", createSchema),
    async (context) => {
      const input = createSchema.parse(await context.req.json());
      return context.json(
        await service.createResource(
          context.get("db"),
          actorFromContext(context),
          input,
        ),
        201,
      );
    },
  );
  registerRoute(
    app,
    routes.getResource,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.getResource(
          context.get("db"),
          context.req.param("resource")!,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.updateResource,
    validate("param", paramSchema),
    validate("json", patchSchema),
    async (context) => {
      const input = patchSchema.parse(await context.req.json());
      return context.json(
        await service.updateResource(
          context.get("db"),
          actorFromContext(context),
          context.req.param("resource")!,
          input,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.disableResource,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.disableResource(
          context.get("db"),
          actorFromContext(context),
          context.req.param("resource")!,
          context.get("environment"),
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.enableResource,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.enableResource(
          context.get("db"),
          actorFromContext(context),
          context.req.param("resource")!,
        ),
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
      await service.eraseResource(
        context.get("db"),
        actorFromContext(context),
        context.req.param("resource")!,
        input.confirm,
        context.get("environment"),
      );
      return context.body(null, 204);
    },
  );
}
