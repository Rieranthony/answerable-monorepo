import {
  commandJson,
  json,
  body,
  pathParameter,
  confirmQuery,
  softDeletion,
} from "./schemas.ts";
import { platformRead } from "./platform-read.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import { platformCommand } from "./command.ts";
import type { Hono } from "hono";
import { z } from "zod";
import * as service from "../../services/clients.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
export const clientSchema = z.object({
  id: z.uuid(),
  clientId: z.string(),
  revision: z.number().int().positive(),
  authorizationVersion: z.number().int().positive(),
  hasClientSecret: z.boolean(),
  redirectUris: z.array(z.string()),
  disabled: z.boolean(),
  organizationId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  name: z.string().nullable(),
  uri: z.string().nullable(),
  tokenEndpointAuthMethod: z.string().nullable(),
  jwks: z.string().nullable(),
  jwksUri: z.string().nullable(),
  contacts: z.array(z.string()).nullable(),
  grantTypes: z.array(z.string()).nullable(),
  responseTypes: z.array(z.string()).nullable(),
  scopes: z.array(z.string()).nullable(),
  clientCredentialsScopes: z.array(z.string()).nullable(),
  requirePKCE: z.boolean().nullable(),
  skipConsent: z.boolean().nullable(),
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
    scopes: scopes.nullable().optional(),
    clientCredentialsScopes: scopes.nullable().optional(),
    jwks: z.string().nullable().optional(),
    jwksUri: z.url().nullable().optional(),
    skipConsent: z.boolean().optional(),
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
    description: `capability_references_exist requires removing all referencing capabilities before erasure. Soft-delete a client, its resource links and consents, clear its secret and delete its token rows, returning no content and recording client.erased. Prefer disableClient for reversible suspension; enabling does not restore revoked grant contexts. Supply confirm equal to clientId; not_found is checked before confirmation_mismatch, then client_has_entitlements requires removing every referencing entitlement before retrying. ${softDeletion}`,
    tag: "Clients",
    platformScope: "platform:write",
    kind: "erase",
    freshAuthentication: true,
    parameters: [...parameters, confirmQuery(z.string().min(1))],
    responses: {
      204: { description: "Client erased" },
      ...problemResponses(404),
    },
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
    responses: {
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
  },
  createClient: {
    method: "post",
    path: "/clients",
    operationId: "createClient",
    summary: "Create client",
    description:
      "Create an OAuth client. validation_failed rejects incompatible settings, not_found means the owner is missing, and conflict prevents identity reuse.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
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
    responses: {
      201: {
        description:
          "Client created; a retry returns the receipt. A lost secret requires a new rotation",
        content: commandJson(
          clientSchema.extend({ clientSecret: z.string().optional() }),
        ),
      },
      ...problemResponses(404),
    },
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
    parameters,
    responses: {
      200: {
        headers: revisionResponseHeaders,
        description: "Client",
        content: json(clientSchema.extend({ resources: z.array(z.string()) })),
      },
      ...problemResponses(400, 404, 409),
    },
  },
  updateClient: {
    method: "patch",
    path: "/clients/:clientId",
    operationId: "updateClient",
    summary: "Update client",
    description:
      "Update a client; accepts the If-Match ETag from getClient. A committed retry returns its receipt before evaluating its old revision. New stale commands return revision_mismatch (412). An unchanged patch records a noop without advancing the revision. Invalid input returns validation_failed; unknown clients return not_found.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: { unlessOnly: ["name", "uri", "contacts"] },
    parameters: [...parameters, revisionParameter],
    requestBody: body(patchSchema),
    example: { body: { name: "Renamed" } },
    responses: {
      200: {
        headers: revisionResponseHeaders,
        description: "Client updated",
        content: commandJson(clientSchema),
      },
      ...problemResponses(404, 412),
    },
  },
  disableClient: {
    method: "post",
    path: "/clients/:clientId/disable",
    operationId: "disableClient",
    summary: "Disable client",
    description:
      "Disable the client, revoke its tokens and stored grant contexts across tenants, and return the updated registration. Prefer enableClient to restore future use; not_found means it is missing; an already disabled client reconciles remaining tokens and contexts, returning 200 with a noop outcome only when nothing changes.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    responses: {
      200: {
        description: "Client disabled and tokens revoked",
        content: commandJson(clientSchema),
      },
      ...problemResponses(404),
    },
  },
  enableClient: {
    method: "post",
    path: "/clients/:clientId/enable",
    operationId: "enableClient",
    summary: "Enable client",
    description:
      "Enable client and return the updated record without restoring revoked grant contexts. Prefer disableClient for the opposite transition; not_found means the target is missing; an already active client returns 200 with a noop outcome.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    responses: {
      200: {
        description: "Client enabled",
        content: commandJson(clientSchema),
      },
      ...problemResponses(404),
    },
  },
  rotateClientSecret: {
    method: "post",
    path: "/clients/:clientId/rotate-secret",
    operationId: "rotateClientSecret",
    summary: "Rotate client secret",
    description:
      "Rotate the client secret, revoking existing client tokens and stored grant contexts across tenants in the same transaction. A retry does not advance the authorisation version again or revoke grants established afterwards; a new key deliberately rotates again. If the first response is lost, rotate again with a new key to obtain a secret. not_found means the client is missing and client_has_no_secret rejects another authentication method.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    responses: {
      200: {
        description:
          "New secret; a retry returns the receipt. A lost secret requires a new rotation",
        content: commandJson(
          z.object({ clientId: z.string(), clientSecret: z.string() }),
        ),
      },
      ...problemResponses(404),
    },
  },
  setClientOwner: {
    method: "put",
    path: "/clients/:clientId/owner",
    operationId: "setClientOwner",
    summary: "Verify unchanged client owner",
    description:
      "Client ownership is immutable. Supplying the current owner returns the registration without changing it; any different owner, including adding or removing one, returns ownership_conflict. Create a replacement client under the new owner and retire the old client. validation_failed rejects malformed ids; not_found means the client is missing.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: parameters,
    requestBody: body(ownerSchema),
    example: {
      body: { organizationId: "00000000-0000-7000-8000-000000000000" },
    },
    responses: {
      200: {
        description: "Client owner unchanged",
        content: commandJson(clientSchema),
      },
      ...problemResponses(404),
    },
  },
  linkClientResource: {
    method: "put",
    path: "/clients/:clientId/resources/:resource",
    operationId: "linkClientResource",
    summary: "Link client resource (URL-encode {resource})",
    description:
      "Link an OAuth client to a resource and return the link, with 201 on creation and 200 when it already exists. The {resource} URL must be percent-encoded in the path; prefer unlinkClientResource to remove the link, and validation_failed or not_found identifies malformed input or a missing target.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: resourceParameters,
    responses: {
      200: {
        description: "Resource link already exists",
        content: commandJson(z.object({ created: z.boolean() })),
      },
      201: {
        description: "Resource linked",
        content: commandJson(z.object({ created: z.boolean() })),
      },
      ...problemResponses(404),
    },
  },
  unlinkClientResource: {
    method: "delete",
    path: "/clients/:clientId/resources/:resource",
    operationId: "unlinkClientResource",
    summary: "Unlink client resource (URL-encode {resource})",
    description:
      "Remove the client-to-resource link and return no content. The {resource} URL must be percent-encoded in the path; prefer linkClientResource to add a link, validation_failed identifies malformed input; not_found means the client is missing. An absent link returns 204 with a noop outcome.",
    tag: "Clients",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: resourceParameters,
    responses: {
      204: {
        description: "Resource unlinked",
      },
      ...problemResponses(404),
    },
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
        "write",
        { clientId, confirm },
        204,
        async (platform) => {
          await service.eraseClient(platform, clientId, confirm);
          return {
            body: null,
            resultReference: { type: "client", id: clientId },
          };
        },
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
      return platformCommand(context, "write", input, 201, async (platform) => {
        const body = await service.createClient(platform, input);
        return {
          body,
          resultReference: { type: "client", id: body.clientId },
        };
      });
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
        "write",
        { clientId, expected, patch: input },
        200,
        async (platform) => {
          const { body, changed } = await service.updateClient(
            platform,
            clientId,
            input,
            expected,
          );
          return {
            body,
            outcome: changed ? "applied" : "noop",
            resultReference: { type: "client", id: clientId },
          };
        },
        { etag: true },
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
        "write",
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
        "write",
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
        "write",
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
        "write",
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
        "write",
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
        "write",
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
      );
    },
  );
}
