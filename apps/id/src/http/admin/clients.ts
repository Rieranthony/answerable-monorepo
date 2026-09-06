import type { Hono } from "hono";
import { resolver } from "hono-openapi";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
import * as service from "../../services/clients.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
const json = (schema: z.ZodType) => ({
  "application/json": { schema: resolver(schema) },
});
const body = (schema: z.ZodType) =>
  ({
    required: true,
    content: { "application/json": { schema: z.toJSONSchema(schema) } },
  }) as AdminRoute["requestBody"];
export const clientSchema = z.object({
  id: z.uuid(),
  clientId: z.string(),
  hasClientSecret: z.boolean(),
  redirectUris: z.array(z.string()),
  dpopBoundAccessTokens: z.boolean(),
  disabled: z.boolean(),
  userId: z.uuid().nullable(),
  organizationId: z.uuid().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  clientDiscoveryId: z.string().nullable(),
  referenceId: z.string().nullable(),
  name: z.string().nullable(),
  uri: z.string().nullable(),
  icon: z.string().nullable(),
  tos: z.string().nullable(),
  policy: z.string().nullable(),
  softwareId: z.string().nullable(),
  softwareVersion: z.string().nullable(),
  softwareStatement: z.string().nullable(),
  backchannelLogoutUri: z.string().nullable(),
  tokenEndpointAuthMethod: z.string().nullable(),
  applicationType: z.string().nullable(),
  jwks: z.string().nullable(),
  jwksUri: z.string().nullable(),
  subjectType: z.string().nullable(),
  contacts: z.array(z.string()).nullable(),
  postLogoutRedirectUris: z.array(z.string()).nullable(),
  grantTypes: z.array(z.string()).nullable(),
  responseTypes: z.array(z.string()).nullable(),
  scopes: z.array(z.string()).nullable(),
  clientCredentialsScopes: z.array(z.string()).nullable(),
  backchannelLogoutSessionRequired: z.boolean().nullable(),
  requirePKCE: z.boolean().nullable(),
  skipConsent: z.boolean().nullable(),
  enableEndSession: z.boolean().nullable(),
});
const scopes = z.array(z.string().min(1));
const createSchema = z.object({
  clientId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{2,63}$/)
    .optional(),
  name: z.string().min(1).max(200),
  organizationId: z.uuid().optional(),
  tokenEndpointAuthMethod: z.enum([
    "client_secret_basic",
    "private_key_jwt",
    "none",
  ]),
  grantTypes: z
    .array(
      z.enum(["client_credentials", "authorization_code", "refresh_token"]),
    )
    .min(1),
  redirectUris: z.array(z.url()).default([]),
  clientCredentialsScopes: scopes.optional(),
  scopes: scopes.optional(),
  jwks: z.string().optional(),
  jwksUri: z.url().optional(),
  skipConsent: z.boolean().optional(),
  uri: z.url().optional(),
  contacts: z.array(z.email()).optional(),
});
const patchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    uri: z.url().nullable().optional(),
    contacts: z.array(z.email()).nullable().optional(),
    redirectUris: z.array(z.url()).optional(),
    postLogoutRedirectUris: z.array(z.url()).nullable().optional(),
    scopes: scopes.nullable().optional(),
    clientCredentialsScopes: scopes.nullable().optional(),
    jwks: z.string().nullable().optional(),
    jwksUri: z.url().nullable().optional(),
    skipConsent: z.boolean().optional(),
    backchannelLogoutUri: z.url().nullable().optional(),
  })
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "At least one field is required",
  );
const ownerSchema = z.object({ organizationId: z.uuid().nullable() });
const querySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  organization: z.uuid().optional(),
  disabled: z.enum(["true", "false"]).optional(),
});
const paramSchema = z.object({ clientId: z.string().min(1) });
const resourceParams = paramSchema.extend({ resource: z.url() });
const parameters = [
  { in: "path", name: "clientId", required: true, schema: { type: "string" } },
] satisfies AdminRoute["parameters"];
const resourceParameters = [
  ...parameters,
  {
    in: "path",
    name: "resource",
    required: true,
    schema: { type: "string", format: "uri" },
  },
] satisfies AdminRoute["parameters"];

export const routes = {
  listClients: {
    method: "get",
    path: "/clients",
    operationId: "listClients",
    summary: "List clients",
    tag: "Clients",
    platformScope: "platform:read",
    kind: "read",
    paginated: true,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Clients",
          content: json(
            z.object({
              items: z.array(clientSchema),
              nextCursor: z.uuid().nullable(),
            }),
          ),
        },
        ...problemResponses(400),
      },
    ),
  },
  createClient: {
    method: "post",
    path: "/clients",
    operationId: "createClient",
    summary: "Create client",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    requestBody: body(createSchema),
    example: {
      body: {
        name: "Example cell",
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        clientCredentialsScopes: ["tutor:read"],
        organizationId: "00000000-0000-7000-8000-000000000000",
      },
    },
    responses: standardResponses(
      {},
      {
        201: {
          description:
            "Client created; the plaintext secret is returned only here and on rotation",
          content: json(
            clientSchema.extend({ clientSecret: z.string().optional() }),
          ),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  getClient: {
    method: "get",
    path: "/clients/:clientId",
    operationId: "getClient",
    summary: "Get client",
    tag: "Clients",
    platformScope: "platform:read",
    kind: "read",
    parameters,
    responses: standardResponses(
      {},
      {
        200: { description: "Client", content: json(clientSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  updateClient: {
    method: "patch",
    path: "/clients/:clientId",
    operationId: "updateClient",
    summary: "Update client",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    requestBody: body(patchSchema),
    example: { body: { name: "Renamed" } },
    responses: standardResponses(
      {},
      {
        200: { description: "Client updated", content: json(clientSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  disableClient: {
    method: "post",
    path: "/clients/:clientId/disable",
    operationId: "disableClient",
    summary: "Disable client",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Client disabled and tokens revoked",
          content: json(clientSchema),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  enableClient: {
    method: "post",
    path: "/clients/:clientId/enable",
    operationId: "enableClient",
    summary: "Enable client",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      {
        200: { description: "Client enabled", content: json(clientSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  rotateClientSecret: {
    method: "post",
    path: "/clients/:clientId/rotate-secret",
    operationId: "rotateClientSecret",
    summary: "Rotate client secret",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      {
        200: {
          description:
            "New plaintext client secret; store it before leaving this response",
          content: json(
            z.object({ clientId: z.string(), clientSecret: z.string() }),
          ),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  setClientOwner: {
    method: "put",
    path: "/clients/:clientId/owner",
    operationId: "setClientOwner",
    summary: "Set client owner",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    requestBody: body(ownerSchema),
    example: {
      body: { organizationId: "00000000-0000-7000-8000-000000000000" },
    },
    responses: standardResponses(
      {},
      {
        200: {
          description: "Client owner changed",
          content: json(clientSchema),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  linkClientResource: {
    method: "put",
    path: "/clients/:clientId/resources/:resource",
    operationId: "linkClientResource",
    summary: "Link client resource (URL-encode {resource})",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    parameters: resourceParameters,
    responses: standardResponses(
      {},
      {
        200: {
          description: "Resource link already exists",
          content: json(z.object({ created: z.boolean() })),
        },
        201: {
          description: "Resource linked",
          content: json(z.object({ created: z.boolean() })),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  unlinkClientResource: {
    method: "delete",
    path: "/clients/:clientId/resources/:resource",
    operationId: "unlinkClientResource",
    summary: "Unlink client resource (URL-encode {resource})",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    parameters: resourceParameters,
    responses: standardResponses(
      {},
      {
        204: { description: "Resource unlinked" },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listClients,
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await service.listClients(context.get("db"), {
          ...query,
          organizationId: query.organization,
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
    routes.createClient,
    validate("json", createSchema),
    async (context) => {
      const input = createSchema.parse(await context.req.json());
      return context.json(
        await service.createClient(
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
    routes.getClient,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.getClient(
          context.get("db"),
          context.req.param("clientId")!,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.updateClient,
    validate("param", paramSchema),
    validate("json", patchSchema),
    async (context) => {
      const input = patchSchema.parse(await context.req.json());
      return context.json(
        await service.updateClient(
          context.get("db"),
          actorFromContext(context),
          context.req.param("clientId")!,
          input,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.disableClient,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.disableClient(
          context.get("db"),
          actorFromContext(context),
          context.req.param("clientId")!,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.enableClient,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.enableClient(
          context.get("db"),
          actorFromContext(context),
          context.req.param("clientId")!,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.rotateClientSecret,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.rotateSecret(
          context.get("db"),
          actorFromContext(context),
          context.req.param("clientId")!,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.setClientOwner,
    validate("param", paramSchema),
    validate("json", ownerSchema),
    async (context) => {
      const input = ownerSchema.parse(await context.req.json());
      return context.json(
        await service.setOwner(
          context.get("db"),
          actorFromContext(context),
          context.req.param("clientId")!,
          input.organizationId,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.linkClientResource,
    validate("param", resourceParams),
    async (context) => {
      const result = await service.linkResource(
        context.get("db"),
        actorFromContext(context),
        context.req.param("clientId")!,
        context.req.param("resource")!,
      );
      return context.json(result, result.created ? 201 : 200);
    },
  );
  registerRoute(
    app,
    routes.unlinkClientResource,
    validate("param", resourceParams),
    async (context) => {
      await service.unlinkResource(
        context.get("db"),
        actorFromContext(context),
        context.req.param("clientId")!,
        context.req.param("resource")!,
      );
      return context.body(null, 204);
    },
  );
}
