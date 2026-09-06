import type { Hono } from "hono";
import { resolver } from "hono-openapi";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import * as service from "../../services/sso-providers.ts";
import { hostSchema } from "./domains.ts";

const paramSchema = z.object({ organizationId: z.uuid() });
const parameters = [
  {
    in: "path",
    name: "organizationId",
    required: true,
    schema: { type: "string", format: "uuid" },
  },
] satisfies AdminRoute["parameters"];
const json = (schema: z.ZodType) => ({
  "application/json": { schema: resolver(schema) },
});
const body = (schema: z.ZodType) =>
  ({
    required: true,
    content: { "application/json": { schema: z.toJSONSchema(schema) } },
  }) as AdminRoute["requestBody"];
const oidcSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tokenEndpointAuthentication: z
    .enum(["client_secret_post", "client_secret_basic", "private_key_jwt"])
    .optional(),
  discoveryEndpoint: z.url().optional(),
  authorizationEndpoint: z.url().optional(),
  tokenEndpoint: z.url().optional(),
  jwksEndpoint: z.url().optional(),
  scopes: z.array(z.string()).optional(),
  pkce: z.boolean().optional(),
});
const putSchema = z.object({
  issuer: z.url(),
  domain: hostSchema,
  oidc: oidcSchema,
});
export const ssoProviderSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  providerId: z.string(),
  issuer: z.string(),
  domain: z.string(),
  oidc: oidcSchema
    .omit({ clientSecret: true })
    .extend({ clientId: z.string().optional(), hasClientSecret: z.boolean() }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const routes = {
  getSsoProvider: {
    method: "get",
    path: "/organizations/:organizationId/sso-provider",
    operationId: "getSsoProvider",
    summary: "Get the SSO provider",
    tag: "SSO provider",
    platformScope: "platform:read",
    kind: "read",
    parameters,
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "SSO provider", content: json(ssoProviderSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
  putSsoProvider: {
    method: "put",
    path: "/organizations/:organizationId/sso-provider",
    operationId: "putSsoProvider",
    summary: "Put the SSO provider",
    tag: "SSO provider",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    requestBody: body(putSchema),
    example: {
      body: {
        issuer: "https://login.example.com",
        domain: "acme.example.com",
        oidc: { clientId: "acme-client", clientSecret: "secret" },
      },
    },
    responses: standardResponses(
      {},
      {
        200: { description: "SSO provider", content: json(ssoProviderSchema) },
        201: {
          description: "SSO provider created",
          content: json(ssoProviderSchema),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  deleteSsoProvider: {
    method: "delete",
    path: "/organizations/:organizationId/sso-provider",
    operationId: "deleteSsoProvider",
    summary: "Delete the SSO provider",
    tag: "SSO provider",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      {
        204: { description: "SSO provider deleted" },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;

export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.getSsoProvider,
    validate("param", paramSchema),
    async (context) =>
      context.json(
        await service.getSsoProvider(
          context.get("db"),
          context.req.param("organizationId")!,
        ),
      ),
  );
  registerRoute(
    app,
    routes.putSsoProvider,
    validate("param", paramSchema),
    validate("json", putSchema),
    async (context) => {
      const result = await service.putSsoProvider(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        putSchema.parse(await context.req.json()),
      );
      return context.json(result.provider, result.created ? 201 : 200);
    },
  );
  registerRoute(
    app,
    routes.deleteSsoProvider,
    validate("param", paramSchema),
    async (context) => {
      await service.deleteSsoProvider(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
      );
      return context.body(null, 204);
    },
  );
}
