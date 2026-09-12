import { commandJson } from "./schemas.ts";
import { platformRead } from "./platform-read.ts";
import { tenantRead } from "./tenant-read.ts";
import {
  requirePutRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import {
  getSsoTestConfiguration,
  testSsoProvider,
  ssoProblemCodes,
} from "../../services/sso-test.ts";
import { json, body, pathParameter, uuidParam } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  platformCommand,
  operationJson,
  idempotencyParameter,
  commandResponseHeaders,
} from "./command.ts";
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
const oidcSchema = z.strictObject({
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
});
const putSchema = z.object({
  issuer: z.url(),
  domain: hostSchema,
  oidc: oidcSchema,
});
export const ssoProviderSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  organizationId: z.uuid(),
  providerId: z.string(),
  issuer: z.string(),
  domain: z.string(),
  oidc: oidcSchema.omit({ clientSecret: true }).extend({
    clientId: z.string().optional(),
    hasClientSecret: z.boolean(),
    pkce: z.boolean().optional(),
  }),
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
    freshAuthentication: false,
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
    freshAuthentication: false,
    parameters,
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "SSO provider",
          headers: revisionResponseHeaders,
          content: json(ssoProviderSchema),
        },
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
      "Requires Idempotency-Key. Accepts the strong If-Match ETag from getSsoProvider for conditional replacement; conflicting/malformed headers return 400; stale state returns 412. Committed replay precedes the original precondition. Identical authorised retries return the receipt without repeating effects. Changed-input reuse conflicts. Create or replace the organisation’s SSO configuration and return the provider with credentials redacted. A real configuration change, including first creation, irreversibly revokes existing tenant grant contexts in the same audited transaction; unchanged configuration preserves them. Other tenants and global browser sessions are preserved. Prefer getSsoProvider to inspect configuration; validation_failed rejects malformed input, not_found means the organisation is missing, and conflict indicates a duplicate provider.",
    tag: "SSO provider",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...parameters,
      idempotencyParameter,
      {
        ...revisionParameter,
        required: false,
        description:
          "For replacement: supply the current provider ETag. Mutually exclusive with If-None-Match; preconditions are optional.",
      },
      {
        in: "header",
        name: "If-None-Match",
        required: false,
        schema: { type: "string", enum: ["*"] },
        description:
          "For creation: assert that no provider exists. Mutually exclusive with If-Match; preconditions are optional.",
      },
    ],
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
        200: {
          description: "SSO provider",
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          content: commandJson(ssoProviderSchema),
        },
        201: {
          description: "SSO provider created",
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          content: commandJson(ssoProviderSchema),
        },
        ...problemResponses(400, 404, 409, 412, 503),
      },
    ),
  },
  deleteSsoProvider: {
    method: "delete",
    path: "/organizations/:organizationId/sso-provider",
    operationId: "deleteSsoProvider",
    summary: "Delete the SSO provider",
    description:
      "Requires Idempotency-Key. Identical authorised retries return the receipt without repeating effects. Changed-input reuse conflicts. Delete the organisation’s SSO configuration and return no content, preventing future sign-in through that provider and irreversibly revoking existing tenant grant contexts in the same audited transaction. Recreating the provider does not restore old grants. Other tenants and global browser sessions are preserved. Prefer putSsoProvider to replace its configuration; validation_failed rejects malformed ids and not_found means the organisation or provider is missing. Product deletion retains rows with terminal deletedAt markers; identifying data can remain. Ordinary reads and authority exclude deleted rows. Enabling cannot restore them. Physical cleanup and its retention period are deferred.",
    tag: "SSO provider",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        204: {
          description: "SSO provider deleted",
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
    routes.testSsoProvider,
    validate("param", paramSchema),
    async (context) =>
      context.json(
        await testSsoProvider(
          await platformRead(context, (platform) =>
            getSsoTestConfiguration(
              platform,
              context.req.param("organizationId")!,
            ),
          ),
          context.get("ssoTest"),
        ),
      ),
  );
  registerRoute(
    app,
    routes.getSsoProvider,
    validate("param", paramSchema),
    async (context) => {
      const result = await tenantRead(
        context,
        "directory",
        service.getSsoProvider,
      );
      context.header("ETag", revisionTag(result));
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.putSsoProvider,
    validate("param", paramSchema),
    validate("json", putSchema),
    async (context) => {
      const expected = requirePutRevision(
        context.req.header("If-Match"),
        context.req.header("If-None-Match"),
      );
      const organizationId = context.req.param("organizationId")!;
      const input = putSchema.parse(await context.req.json());
      input.oidc.tokenEndpointAuthentication ??= "client_secret_post";
      input.oidc.discoveryEndpoint ??= `${input.issuer}/.well-known/openid-configuration`;
      if (input.oidc.scopes)
        input.oidc.scopes = [...new Set(input.oidc.scopes)].sort();
      return platformCommand(
        context,
        "putSsoProvider",
        operationJson({ organizationId, expected, input }),
        200,
        async (platform) => {
          const result = await service.putSsoProvider(
            platform,
            organizationId,
            input,
            expected,
          );
          return {
            body: result.provider,
            statusCode: result.created ? 201 : 200,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "sso_provider", id: result.provider.id },
          };
        },
        {
          etag: (body) =>
            revisionTag(
              ssoProviderSchema.pick({ id: true, revision: true }).parse(body),
            ),
        },
      );
    },
  );
  registerRoute(
    app,
    routes.deleteSsoProvider,
    validate("param", paramSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      return platformCommand(
        context,
        "deleteSsoProvider",
        { organizationId },
        204,
        async (platform) => {
          const id = await service.deleteSsoProvider(platform, organizationId);
          return { body: null, resultReference: { type: "sso_provider", id } };
        },
      );
    },
  );
}
