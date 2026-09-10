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
import { getOrganizationSummary } from "../../services/summary.ts";
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
const counter = z.number().int().nonnegative();
const statusCounts = z.object({ active: counter, disabled: counter });
export const organizationSummarySchema = z.object({
  organization: organizationSchema,
  domains: statusCounts,
  ssoProvider: z.object({
    configured: z.boolean(),
    kind: z.enum(["entra", "google", "oidc"]).nullable(),
    issuer: z.string().nullable(),
  }),
  members: z.object({
    total: counter,
    effective: counter,
    byStatus: statusCounts.extend({ inert: counter }),
  }),
  groups: statusCounts,
  entitlements: statusCounts.extend({
    targets: z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("client"), id: z.string(), rows: counter }),
        z.object({
          kind: z.literal("resource"),
          id: z.string(),
          rows: counter,
        }),
        z.object({
          kind: z.literal("client_resource"),
          id: z.string(),
          resource: z.url(),
          rows: counter,
        }),
      ]),
    ),
  }),
  clients: z.object({ owned: counter }),
  signIns7d: z.object({
    succeeded: counter,
    lastSucceededAt: z.iso.datetime().nullable(),
  }),
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
  getOrganizationSummary: {
    method: "get",
    path: "/organizations/:organizationId/summary",
    operationId: "getOrganizationSummary",
    summary: "Summarise an organisation",
    description:
      "Read an organisation and its counts without paging or changing state. Domains, groups and entitlements use stored status; entitlement targets count all rows, including disabled or out-of-window grants, by exact client-resource pair or standalone client/resource target. Pair entries use kind client_resource, id for the client and resource for the resource identifier. Counts are not permission decisions. Members.total includes every membership, effective counts windows with an inclusive start and exclusive end at the current instant, and byStatus counts the linked users regardless of window. Owned clients include disabled clients. Global browser session counts are not tenant data and are omitted. SSO reports the configured issuer and its kind. Successful sign-ins cover the trailing seven days in UTC, including the cutoff instant; lastSucceededAt is the latest success in that window, or null. Rejections carry no organisation and cannot be counted per organisation; use getPlatformSummary for fleet rejections. validation_failed rejects malformed ids; not_found means the organisation is missing or unavailable.",
    tag: "Organizations",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    parameters,
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "Organisation summary",
          content: json(organizationSummarySchema),
        },
        ...problemResponses(400),
      },
    ),
  },
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
      "Requires Idempotency-Key. Identical authorised retries recover the original response for seven days; changed input conflicts and expired recovery never repeats effects. Create an organisation and return its generated id and stored fields, recording the creation in the audit log. Prefer updateOrganization when its id already exists; validation_failed rejects malformed input and conflict means the slug is already in use.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters: [idempotencyParameter],
    requestBody: body(createSchema),
    example: { body: { slug: "acme", name: "Acme" } },
    responses: standardResponses(
      {},
      {
        201: {
          description: "Organisation created",
          content: json(organizationSchema),
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 409, 410, 503),
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
      "Requires Idempotency-Key and the If-Match ETag from getOrganization. Missing preconditions return 428; stale new commands return 412. Committed replay precedes its old revision check. An unchanged patch preserves the revision. Identical authorised retries recover the original response for seven days; changed input conflicts and expired recovery never repeats effects. Update an organisation and return the updated record, recording the change in the audit log. Prefer getOrganization to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters: [...parameters, idempotencyParameter, revisionParameter],
    requestBody: body(patchSchema),
    example: { body: { name: "Acme Ltd" } },
    responses: standardResponses(
      {},
      {
        200: {
          ...success[200],
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
        },
        ...problemResponses(400, 404, 409, 410, 412, 428, 503),
      },
    ),
  },
  disableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/disable",
    operationId: "disableOrganization",
    summary: "Disable an organisation",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original response for seven days; changed input conflicts and expired recovery never repeats effects. Disable the organisation, advance its authorizationVersion, revoke stored machine access tokens for its owned clients, and return the updated organisation. Global browser sessions and unbound user tokens are preserved; client ownership does not establish a user grant’s tenant. Complete tenant user-grant revocation is not yet implemented. Prefer enableOrganization to allow future access without restoring revoked credentials; validation_failed rejects malformed ids, not_found means the organisation is missing, and already disabled state returns a noop without another epoch advance. Disabling the bound platform organisation while an effective writer exists raises last_platform_administrator and rolls back the command; adding another writer in that same organisation does not make its disable safe.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: { ...success[200], headers: commandResponseHeaders },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  enableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/enable",
    operationId: "enableOrganization",
    summary: "Enable an organisation",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original response for seven days; changed input conflicts and expired recovery never repeats effects. Enable an organisation and return the updated record. Its authorizationVersion stays advanced, so pre-disable machine tokens remain invalid at the admin API; obtain fresh tokens. Prefer disableOrganization for the opposite transition; not_found means the target is missing and already active state returns a noop.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters: [...parameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: { ...success[200], headers: commandResponseHeaders },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  eraseOrganization: {
    method: "delete",
    path: "/organizations/:organizationId",
    operationId: "eraseOrganization",
    summary: "Erase an organisation",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original response for seven days; changed input conflicts and expired recovery never repeats effects. Permanently erase the organization and return no content; organization_has_clients requires removing owned clients first. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableOrganization for reversible offboarding.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "erase",
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
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;

export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.getOrganizationSummary,
    validate("param", paramSchema),
    async (context) =>
      context.json(
        await tenantRead(context, "directory", getOrganizationSummary),
      ),
  );
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
        { retention: "ordinary" },
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
        { organizationId, expected, patch },
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
          retention: "ordinary",
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
        { retention: "ordinary" },
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
        { retention: "ordinary" },
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
        { retention: "ordinary" },
      );
    },
  );
}
