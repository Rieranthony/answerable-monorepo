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
import { actorFromContext } from "../../services/actor.ts";
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
  name: z.string(),
  slug: z.string(),
  logo: z.string().nullable(),
  metadata: z.string().nullable(),
  status: z.enum(lifecycleStatuses),
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
      z.object({
        kind: z.enum(["client", "resource"]),
        id: z.string(),
        rows: counter,
      }),
    ),
  }),
  clients: z.object({ owned: counter }),
  sessions: z.object({ active: counter }),
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
      "Read an organisation and its counts without paging or changing state. Domains, groups and entitlements use stored status; entitlement targets count all rows, including disabled or out-of-window grants, by client id or resource identifier. Members.total includes every membership, effective counts windows with an inclusive start and exclusive end at the current instant, and byStatus counts the linked users regardless of window. Owned clients include disabled clients. Active sessions are unexpired sessions belonging to any member, regardless of membership window or active session organisation. SSO reports the configured issuer and its kind. Successful sign-ins cover the trailing seven days in UTC, including the cutoff instant; lastSucceededAt is the latest success in that window, or null. Rejections carry no organisation and cannot be counted per organisation; use getPlatformSummary for fleet rejections. validation_failed rejects malformed ids; not_found means the organisation is missing or unavailable.",
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
      "Create an organisation and return its generated id and stored fields, recording the creation in the audit log. Prefer updateOrganization when its id already exists; validation_failed rejects malformed input and conflict means the slug is already in use.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    requestBody: body(createSchema),
    example: { body: { slug: "acme", name: "Acme" } },
    responses: standardResponses(
      {},
      {
        201: {
          description: "Organisation created",
          content: json(organizationSchema),
        },
        ...problemResponses(400, 409),
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
      { ...success, ...problemResponses(400) },
    ),
  },
  updateOrganization: {
    method: "patch",
    path: "/organizations/:organizationId",
    operationId: "updateOrganization",
    summary: "Update an organisation",
    description:
      "Update an organisation and return the updated record, recording the change in the audit log. Prefer getOrganization to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    requestBody: body(patchSchema),
    example: { body: { name: "Acme Ltd" } },
    responses: standardResponses(
      {},
      { ...success, ...problemResponses(400, 404, 409) },
    ),
  },
  disableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/disable",
    operationId: "disableOrganization",
    summary: "Disable an organisation",
    description:
      "Disable the organisation, revoke member sessions and user and owned-client tokens, and return the updated organisation. Prefer enableOrganization to allow future access without restoring revoked credentials; validation_failed rejects malformed ids, not_found means the organisation is missing, and organization_already_disabled means no transition is needed.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      { ...success, ...problemResponses(400, 404, 409) },
    ),
  },
  enableOrganization: {
    method: "post",
    path: "/organizations/:organizationId/enable",
    operationId: "enableOrganization",
    summary: "Enable an organisation",
    description:
      "Enable an organisation and return the updated record. Prefer disableOrganization for the opposite transition; not_found means the target is missing and organization_already_active means no transition is needed.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    responses: standardResponses(
      {},
      { ...success, ...problemResponses(400, 404, 409) },
    ),
  },
  eraseOrganization: {
    method: "delete",
    path: "/organizations/:organizationId",
    operationId: "eraseOrganization",
    summary: "Erase an organisation",
    description:
      "Permanently erase the organization and return no content; organization_has_clients requires reassigning owned clients first. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableOrganization for reversible offboarding.",
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "erase",
    parameters: [...parameters, confirmQuery(eraseSchema.shape.confirm)],
    example: { query: { confirm: "00000000-0000-7000-8000-000000000000" } },
    responses: standardResponses(
      {},
      {
        204: { description: "Organisation erased" },
        ...problemResponses(400, 404, 409),
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
        await getOrganizationSummary(
          context.get("db"),
          context.req.param("organizationId")!,
        ),
      ),
  );
  registerRoute(
    app,
    routes.listOrganizations,
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await service.listOrganizations(context.get("db"), query),
      );
    },
  );
  registerRoute(
    app,
    routes.createOrganization,
    validate("json", createSchema),
    async (context) => {
      const input = createSchema.parse(await context.req.json());
      return context.json(
        await service.createOrganization(
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
    routes.getOrganization,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.getOrganization(
          context.get("db"),
          context.req.param("organizationId")!,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.updateOrganization,
    validate("param", paramSchema),
    validate("json", patchSchema),
    async (context) => {
      const patch = patchSchema.parse(await context.req.json());
      return context.json(
        await service.updateOrganization(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          patch,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.disableOrganization,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.disableOrganization(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.enableOrganization,
    validate("param", paramSchema),
    async (context) => {
      return context.json(
        await service.enableOrganization(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
        ),
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
      await service.eraseOrganization(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        confirm,
      );
      return context.body(null, 204);
    },
  );
}
