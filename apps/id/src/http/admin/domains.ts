import { tenantRead } from "./tenant-read.ts";
import { json, body, pathParameter, uuidParam } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  platformCommand,
  idempotencyParameter,
  commandResponseHeaders,
} from "./command.ts";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
import { pageQuerySchema } from "../pagination.ts";
import * as service from "../../services/domains.ts";

export const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
export const domainSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  domain: z.string(),
  status: z.enum(lifecycleStatuses),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const createSchema = z.object({ domain: hostSchema });
const querySchema = pageQuerySchema.extend({
  status: z.enum(lifecycleStatuses).optional(),
});
const paramSchema = uuidParam("organizationId");
const parameters = [
  pathParameter("organizationId", "uuid"),
] satisfies AdminRoute["parameters"];
const domainParams = paramSchema.extend({ domainId: z.uuid() });
const domainParameters = [
  ...parameters,
  pathParameter("domainId", "uuid"),
] satisfies AdminRoute["parameters"];

export const routes = {
  deleteOrganizationDomain: {
    method: "delete",
    path: "/organizations/:organizationId/domains/:domainId",
    operationId: "deleteOrganizationDomain",
    summary: "Delete organisation domain",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating its audit or mutation. Changed input returns idempotency_key_reused; expired recovery returns operation_result_expired and never repeats effects. Delete a domain assignment and return no content, removing its sign-in discovery routing and recording domain.deleted. Prefer disableOrganizationDomain for a reversible suspension; validation_failed rejects malformed ids and not_found means the organisation or domain is missing. No confirmation is required. Product deletion retains rows with terminal deletedAt markers; identifying data can remain. Ordinary reads and authority exclude deleted rows. Enabling cannot restore them. Physical cleanup and its retention period are deferred.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...domainParameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        204: { description: "Domain deleted", headers: commandResponseHeaders },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  listOrganizationDomains: {
    method: "get",
    path: "/organizations/:organizationId/domains",
    operationId: "listOrganizationDomains",
    summary: "List organisation domains",
    description:
      "Return all domains assigned to an organisation without changing state. Use createOrganizationDomain to add a sign-in domain; validation_failed rejects malformed ids and not_found means the organisation is unavailable.",
    tag: "Domains",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters,
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "Domains",
          content: json(
            z.object({
              items: z.array(domainSchema),
              nextCursor: z.uuid().nullable(),
            }),
          ),
        },
        ...problemResponses(400, 404),
      },
    ),
  },
  createOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains",
    operationId: "createOrganizationDomain",
    summary: "Create an organisation domain",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating its audit or mutation. Changed input returns idempotency_key_reused; expired recovery returns operation_result_expired and never repeats effects. Add an email domain to an organisation and return the created domain, enabling domain-based sign-in discovery. Prefer listOrganizationDomains to inspect existing assignments; validation_failed rejects malformed input, not_found means the organisation is missing, and conflict means the domain is already assigned.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...parameters, idempotencyParameter],
    requestBody: body(createSchema),
    example: { body: { domain: "acme.example.com" } },
    responses: standardResponses(
      {},
      {
        201: {
          description: "Domain",
          content: json(domainSchema),
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  disableOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains/:domainId/disable",
    operationId: "disableOrganizationDomain",
    summary: "Disable an organisation domain",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating its audit or mutation. Changed input returns idempotency_key_reused; expired recovery returns operation_result_expired and never repeats effects. Disable an organisation domain and return the updated record. Prefer enableOrganizationDomain for the opposite transition; not_found means the target is missing and an already disabled assignment returns unchanged state and records a noop.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...domainParameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Domain",
          content: json(domainSchema),
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  enableOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains/:domainId/enable",
    operationId: "enableOrganizationDomain",
    summary: "Enable an organisation domain",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating its audit or mutation. Changed input returns idempotency_key_reused; expired recovery returns operation_result_expired and never repeats effects. Enable an organisation domain and return the updated record. Prefer disableOrganizationDomain for the opposite transition; not_found means the target is missing and an already active assignment returns unchanged state and records a noop.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [...domainParameters, idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Domain",
          content: json(domainSchema),
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
    routes.deleteOrganizationDomain,
    validate("param", domainParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const domainId = context.req.param("domainId")!;
      return platformCommand(
        context,
        "deleteOrganizationDomain",
        { organizationId, domainId },
        204,
        async (platform) => {
          await service.deleteOrganizationDomain(
            platform,
            organizationId,
            domainId,
          );
          return {
            body: null,
            resultReference: { type: "domain", id: domainId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.listOrganizationDomains,
    validate("param", paramSchema),
    validate("query", querySchema),
    async (context) =>
      context.json(
        await tenantRead(context, "directory", (tenant) =>
          service.listDomains(tenant, querySchema.parse(context.req.query())),
        ),
      ),
  );
  registerRoute(
    app,
    routes.createOrganizationDomain,
    validate("param", paramSchema),
    validate("json", createSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const input = createSchema.parse(await context.req.json());
      return platformCommand(
        context,
        "createOrganizationDomain",
        { organizationId, ...input },
        201,
        async (platform) => {
          const body = await service.createDomain(
            platform,
            organizationId,
            input,
          );
          return { body, resultReference: { type: "domain", id: body.id } };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.disableOrganizationDomain,
    validate("param", domainParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const domainId = context.req.param("domainId")!;
      return platformCommand(
        context,
        "disableOrganizationDomain",
        { organizationId, domainId },
        200,
        async (platform) => {
          const result = await service.disableDomain(
            platform,
            organizationId,
            domainId,
          );
          return {
            body: result.domain,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "domain", id: domainId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.enableOrganizationDomain,
    validate("param", domainParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const domainId = context.req.param("domainId")!;
      return platformCommand(
        context,
        "enableOrganizationDomain",
        { organizationId, domainId },
        200,
        async (platform) => {
          const result = await service.enableDomain(
            platform,
            organizationId,
            domainId,
          );
          return {
            body: result.domain,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "domain", id: domainId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
}
