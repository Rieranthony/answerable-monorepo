import { testSsoProvider, ssoProblemCodes } from "../../services/sso-test.ts";
import { json, body, pathParameter, uuidParam } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import * as service from "../../services/sso-providers.ts";
import { hostSchema } from "./domains.ts";

const paramSchema = uuidParam("organizationId");
const parameters = [
  pathParameter("organizationId", "uuid"),
] satisfies AdminRoute["parameters"];
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
export const ssoTestSchema = z.object({
  issuer: z.string(),
  kind: z.enum(["entra", "google", "oidc"]),
  discovery: z.object({
    url: z.string(),
    reachable: z.boolean(),
    status: z.number().nullable(),
    issuerMatches: z.boolean().nullable(),
    authorizationEndpoint: z.string().nullable(),
    tokenEndpoint: z.string().nullable(),
    jwksUri: z.string().nullable(),
  }),
  jwks: z.object({
    reachable: z.boolean(),
    keys: z.number().int().nonnegative().nullable(),
  }),
  elapsedMs: z.number().nonnegative(),
  problems: z.array(
    z.object({ code: z.enum(ssoProblemCodes), detail: z.string() }),
  ),
});
export const routes = {
  testSsoProvider: {
    method: "get",
    path: "/organizations/:organizationId/sso-provider/test",
    operationId: "testSsoProvider",
    summary: "Test SSO connectivity",
    description:
      "Perform an outbound request to discovery and JWKS endpoints without changing state or sending credentials. Report reachability, issuer equality and key count; problems explain failed checks. Credentials are only provable by a real sign-in. Private hosts, insecure URLs and redirects are refused. Use diagnoseSignIn for database checks for an email. validation_failed rejects malformed ids; provider_not_found returns 404 when no provider exists.",
    tag: "Diagnostics",
    platformScope: "platform:read",
    kind: "read",
    parameters,
    responses: standardResponses(
      {},
      {
        200: {
          description: "SSO connectivity diagnosis",
          content: json(ssoTestSchema),
        },
        ...problemResponses(400, 404),
      },
    ),
  },
  getSsoProvider: {
    method: "get",
    path: "/organizations/:organizationId/sso-provider",
    operationId: "getSsoProvider",
    summary: "Get the SSO provider",
    description:
      "Return the organisation’s SSO provider with credentials redacted, without changing state. Use putSsoProvider to configure or replace it; validation_failed rejects malformed ids and not_found means the organisation or provider is missing.",
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
    description:
      "Create or replace the organisation’s SSO configuration and return the provider with credentials redacted. Prefer getSsoProvider to inspect configuration; validation_failed rejects malformed input, not_found means the organisation is missing, and conflict indicates a duplicate provider.",
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
    description:
      "Delete the organisation’s SSO configuration and return no content, preventing future sign-in through that provider. Prefer putSsoProvider to replace its configuration; validation_failed rejects malformed ids and not_found means the organisation or provider is missing.",
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
    routes.testSsoProvider,
    validate("param", paramSchema),
    async (context) =>
      context.json(
        await testSsoProvider(
          context.get("db"),
          context.req.param("organizationId")!,
          context.get("ssoTest"),
        ),
      ),
  );
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
