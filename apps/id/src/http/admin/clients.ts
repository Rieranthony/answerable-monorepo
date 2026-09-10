import { platformRead } from "./platform-read.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import {
  idempotencyParameter,
  commandResponseHeaders,
  operationJson,
  platformCommand,
} from "./command.ts";
import { json, body, pathParameter, confirmQuery } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import * as service from "../../services/clients.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
export const clientSchema = z.object({
  id: z.uuid(),
  clientId: z.string(),
  revision: z.number().int().positive(),
  authorizationVersion: z.number().int().positive(),
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
  organizationId: z.uuid().optional(),
  disabled: z.enum(["true", "false"]).optional(),
});
const eraseSchema = z.object({ confirm: z.string().min(1) });
const paramSchema = z.object({ clientId: z.string().min(1) });
const resourceParams = paramSchema.extend({ resource: z.url() });
const parameters = [
  pathParameter("clientId"),
] satisfies AdminRoute["parameters"];
const resourceParameters = [
  ...parameters,
  pathParameter("resource", "uri"),
] satisfies AdminRoute["parameters"];

export const routes = {
  eraseClient: {
    method: "delete",
    path: "/clients/:clientId",
    operationId: "eraseClient",
    summary: "Erase client",
    description:
      "capability_references_exist requires removing all referencing capabilities before erasure. Requires Idempotency-Key; identical authorised retries recover the original result for seven days. Soft-delete a client, its resource links and consents, clear its secret and delete its token rows, returning no content and recording client.erased. Prefer disableClient for reversible suspension; enabling does not restore revoked grant contexts. Supply confirm equal to clientId; not_found is checked before confirmation_mismatch, then client_has_entitlements requires removing every referencing entitlement before retrying. Product deletion retains rows with terminal deletedAt markers; identifying data can remain. Ordinary reads and authority exclude deleted rows. Enabling cannot restore them. Physical cleanup and its retention period are deferred.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "erase",
    freshAuthentication: true,
    parameters: [
      ...parameters,
      idempotencyParameter,
      confirmQuery(z.string().min(1)),
    ],
    responses: standardResponses(
      {},
      {
        204: { headers: commandResponseHeaders, description: "Client erased" },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  listClients: {
    method: "get",
    path: "/clients",
    operationId: "listClients",
    summary: "List clients",
    description:
      "Return a cursor page of clients, without changing state. Prefer getClient for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors.",
    tag: "Clients",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
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
    description:
      "Create an OAuth client with a required Idempotency-Key. Identical authorised retries recover the original registration and secret for up to 24 hours, without another creation. Operation-Id identifies the journal record and Idempotency-Replayed marks recovery. A changed input returns idempotency_key_reused; a running duplicate returns retryable operation_in_progress; expired recovery returns operation_result_expired and never recreates the client. validation_failed rejects incompatible settings, not_found means the owner is missing, and identifier_reserved prevents identity reuse.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [idempotencyParameter],
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
          headers: commandResponseHeaders,
          description:
            "Client created; the original response is recoverable with the same key for 24 hours",
          content: json(
            clientSchema.extend({ clientSecret: z.string().optional() }),
          ),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  getClient: {
    method: "get",
    path: "/clients/:clientId",
    operationId: "getClient",
    summary: "Get client",
    description:
      "Return the OAuth client registration without revealing a secret or changing state. Prefer listClients to discover a clientId; validation_failed rejects malformed ids and not_found means the client is missing.",
    tag: "Clients",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters,
    responses: standardResponses(
      {},
      {
        200: {
          headers: revisionResponseHeaders,
          description: "Client",
          content: json(
            clientSchema.extend({ resources: z.array(z.string()) }),
          ),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  updateClient: {
    method: "patch",
    path: "/clients/:clientId",
    operationId: "updateClient",
    summary: "Update client",
    description:
      "Update a client with Idempotency-Key and the If-Match ETag from getClient. A committed retry returns its original result for seven days before evaluating its old revision. New stale commands return revision_mismatch (412); missing If-Match returns precondition_required (428). An unchanged patch records a noop without advancing the revision. Invalid input returns validation_failed; unknown clients return not_found.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: { unlessOnly: ["name", "uri", "contacts"] },
    parameters: [...parameters, idempotencyParameter, revisionParameter],
    requestBody: body(patchSchema),
    example: { body: { name: "Renamed" } },
    responses: standardResponses(
      {},
      {
        200: {
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          description: "Client updated",
          content: json(clientSchema),
        },
        ...problemResponses(400, 404, 409, 410, 412, 428, 503),
      },
    ),
  },
  disableClient: {
    method: "post",
    path: "/clients/:clientId/disable",
    operationId: "disableClient",
    summary: "Disable client",
    description:
      "Requires Idempotency-Key; identical authorised retries recover the original result for seven days. Disable the client, revoke its tokens and stored grant contexts across tenants, and return the updated registration. Prefer enableClient to restore future use; not_found means it is missing; an already disabled client reconciles remaining tokens and contexts, returning 200 with a noop outcome only when nothing changes.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          headers: commandResponseHeaders,
          description: "Client disabled and tokens revoked",
          content: json(clientSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  enableClient: {
    method: "post",
    path: "/clients/:clientId/enable",
    operationId: "enableClient",
    summary: "Enable client",
    description:
      "Requires Idempotency-Key; identical authorised retries recover the original result for seven days. Enable client and return the updated record without restoring revoked grant contexts. Prefer disableClient for the opposite transition; not_found means the target is missing; an already active client returns 200 with a noop outcome.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          headers: commandResponseHeaders,
          description: "Client enabled",
          content: json(clientSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  rotateClientSecret: {
    method: "post",
    path: "/clients/:clientId/rotate-secret",
    operationId: "rotateClientSecret",
    summary: "Rotate client secret",
    description:
      "Rotate the client secret with a required Idempotency-Key, revoking existing client tokens and stored grant contexts across tenants in the same transaction. Identical authorised retries recover the same secret for up to 24 hours without rotating again, advancing the authorisation version or revoking grants established afterwards. A new key deliberately rotates again. Operation-Id identifies the result and Idempotency-Replayed marks recovery. operation_result_expired requires a deliberate new rotation; operation_in_progress is retryable with the same key. not_found means the client is missing and client_has_no_secret rejects another authentication method.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          headers: commandResponseHeaders,
          description:
            "Original rotation result, recoverable for 24 hours with the same key",
          content: json(
            z.object({ clientId: z.string(), clientSecret: z.string() }),
          ),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  setClientOwner: {
    method: "put",
    path: "/clients/:clientId/owner",
    operationId: "setClientOwner",
    summary: "Verify unchanged client owner",
    description:
      "Requires Idempotency-Key; identical authorised retries recover the original result for seven days. Client ownership is immutable. Supplying the current owner returns the registration without changing it; any different owner, including adding or removing one, returns ownership_conflict. Create a replacement client under the new owner and retire the old client. validation_failed rejects malformed ids; not_found means the client is missing.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    requestBody: body(ownerSchema),
    example: {
      body: { organizationId: "00000000-0000-7000-8000-000000000000" },
    },
    responses: standardResponses(
      {},
      {
        200: {
          headers: commandResponseHeaders,
          description: "Client owner unchanged",
          content: json(clientSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  linkClientResource: {
    method: "put",
    path: "/clients/:clientId/resources/:resource",
    operationId: "linkClientResource",
    summary: "Link client resource (URL-encode {resource})",
    description:
      "Requires Idempotency-Key; identical authorised retries recover the original result for seven days. Link an OAuth client to a resource and return the link, with 201 on creation and 200 when it already exists. The {resource} URL must be percent-encoded in the path; prefer unlinkClientResource to remove the link, and validation_failed or not_found identifies malformed input or a missing target.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...resourceParameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          headers: commandResponseHeaders,
          description: "Resource link already exists",
          content: json(z.object({ created: z.boolean() })),
        },
        201: {
          headers: commandResponseHeaders,
          description: "Resource linked",
          content: json(z.object({ created: z.boolean() })),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  unlinkClientResource: {
    method: "delete",
    path: "/clients/:clientId/resources/:resource",
    operationId: "unlinkClientResource",
    summary: "Unlink client resource (URL-encode {resource})",
    description:
      "Requires Idempotency-Key; identical authorised retries recover the original result for seven days. Remove the client-to-resource link and return no content. The {resource} URL must be percent-encoded in the path; prefer linkClientResource to add a link, validation_failed identifies malformed input; not_found means the client is missing. An absent link returns 204 with a noop outcome.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...resourceParameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        204: {
          headers: commandResponseHeaders,
          description: "Resource unlinked",
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.eraseClient,
    validate("param", paramSchema),
    validate("query", eraseSchema),
    async (context) => {
      const clientId = context.req.param("clientId")!;
      const confirm = eraseSchema.parse(context.req.query()).confirm;
      return platformCommand(
        context,
        "eraseClient",
        { clientId, confirm },
        204,
        async (platform) => {
          await service.eraseClient(platform, clientId, confirm);
          return {
            body: null,
            resultReference: { type: "client", id: clientId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.listClients,
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await platformRead(context, (platform) =>
          service.listClients(platform, {
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
    routes.createClient,
    validate("json", createSchema),
    async (context) => {
      const parsed = createSchema.parse(await context.req.json());
      const input = {
        ...parsed,
        grantTypes: [...new Set(parsed.grantTypes)].sort(),
        clientCredentialsScopes:
          parsed.clientCredentialsScopes === undefined
            ? undefined
            : [...new Set(parsed.clientCredentialsScopes)].sort(),
        scopes:
          parsed.scopes === undefined
            ? undefined
            : [...new Set(parsed.scopes)].sort(),
      };
      return platformCommand(
        context,
        "createClient",
        operationJson(input),
        201,
        async (platform) => {
          const body = await service.createClient(platform, input);
          return {
            body,
            resultReference: { type: "client", id: body.clientId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.getClient,
    validate("param", paramSchema),
    async (context) => {
      const body = await platformRead(context, (platform) =>
        service.getClient(platform, context.req.param("clientId")!),
      );
      context.header("ETag", revisionTag(body));
      return context.json(body);
    },
  );
  registerRoute(
    app,
    routes.updateClient,
    validate("param", paramSchema),
    validate("json", patchSchema),
    async (context) => {
      const input = patchSchema.parse(await context.req.json());
      for (const key of ["scopes", "clientCredentialsScopes"] as const)
        if (input[key]) input[key] = [...new Set(input[key])].sort();
      const expected = requireRevision(context.req.header("If-Match"));
      const clientId = context.req.param("clientId")!;
      return platformCommand(
        context,
        "updateClient",
        operationJson({ clientId, expected, patch: input }),
        200,
        async (platform) => {
          const body = await service.updateClient(
            platform,
            clientId,
            input,
            expected,
          );
          return {
            body,
            outcome: body.revision === expected.revision ? "noop" : "applied",
            resultReference: { type: "client", id: clientId },
          };
        },
        {
          retention: "ordinary",
          etag: (body) =>
            revisionTag(
              clientSchema.pick({ id: true, revision: true }).parse(body),
            ),
        },
      );
    },
  );
  registerRoute(
    app,
    routes.disableClient,
    validate("param", paramSchema),
    async (context) => {
      const clientId = context.req.param("clientId")!;
      return platformCommand(
        context,
        "disableClient",
        { clientId },
        200,
        async (platform) => {
          const result = await service.disableClient(platform, clientId);
          return {
            body: result.client,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "client", id: clientId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.enableClient,
    validate("param", paramSchema),
    async (context) => {
      const clientId = context.req.param("clientId")!;
      return platformCommand(
        context,
        "enableClient",
        { clientId },
        200,
        async (platform) => {
          const result = await service.enableClient(platform, clientId);
          return {
            body: result.client,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "client", id: clientId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.rotateClientSecret,
    validate("param", paramSchema),
    async (context) => {
      const clientId = context.req.param("clientId")!;
      return platformCommand(
        context,
        "rotateClientSecret",
        { clientId },
        200,
        async (platform) => ({
          body: await service.rotateSecret(platform, clientId),
          resultReference: { type: "client", id: clientId },
        }),
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
      const clientId = context.req.param("clientId")!;
      return platformCommand(
        context,
        "setClientOwner",
        { clientId, ...input },
        200,
        async (platform) => ({
          body: await service.setOwner(
            platform,
            clientId,
            input.organizationId,
          ),
          outcome: "noop",
          resultReference: { type: "client", id: clientId },
        }),
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.linkClientResource,
    validate("param", resourceParams),
    async (context) => {
      const clientId = context.req.param("clientId")!;
      const resource = context.req.param("resource")!;
      return platformCommand(
        context,
        "linkClientResource",
        { clientId, resource },
        201,
        async (platform) => {
          const result = await service.linkResource(
            platform,
            clientId,
            resource,
          );
          return {
            body: result,
            outcome: result.created ? "applied" : "noop",
            statusCode: result.created ? 201 : 200,
            resultReference: { type: "client", id: clientId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.unlinkClientResource,
    validate("param", resourceParams),
    async (context) => {
      const clientId = context.req.param("clientId")!;
      const resource = context.req.param("resource")!;
      return platformCommand(
        context,
        "unlinkClientResource",
        { clientId, resource },
        204,
        async (platform) => {
          const result = await service.unlinkResource(
            platform,
            clientId,
            resource,
          );
          return {
            body: null,
            outcome: result.removed ? "applied" : "noop",
            resultReference: { type: "client", id: clientId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
}
