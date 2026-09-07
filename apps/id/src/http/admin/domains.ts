import { json, body, pathParameter, uuidParam } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
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
      "Delete a domain assignment and return no content, removing its sign-in discovery routing and recording domain.deleted. Prefer disableOrganizationDomain for a reversible suspension; validation_failed rejects malformed ids and not_found means the organisation or domain is missing. No confirmation is required.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    parameters: domainParameters,
    responses: standardResponses(
      {},
      { 204: { description: "Domain deleted" }, ...problemResponses(400, 404) },
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
      "Add an email domain to an organisation and return the created domain, enabling domain-based sign-in discovery. Prefer listOrganizationDomains to inspect existing assignments; validation_failed rejects malformed input, not_found means the organisation is missing, and conflict means the domain is already assigned.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    parameters,
    requestBody: body(createSchema),
    example: { body: { domain: "acme.example.com" } },
    responses: standardResponses(
      {},
      {
        201: { description: "Domain", content: json(domainSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  disableOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains/:domainId/disable",
    operationId: "disableOrganizationDomain",
    summary: "Disable an organisation domain",
    description:
      "Disable an organisation domain and return the updated record. Prefer enableOrganizationDomain for the opposite transition; not_found means the target is missing and domain_already_disabled means no transition is needed.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    parameters: domainParameters,
    responses: standardResponses(
      {},
      {
        200: { description: "Domain", content: json(domainSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  enableOrganizationDomain: {
    method: "post",
    path: "/organizations/:organizationId/domains/:domainId/enable",
    operationId: "enableOrganizationDomain",
    summary: "Enable an organisation domain",
    description:
      "Enable an organisation domain and return the updated record. Prefer disableOrganizationDomain for the opposite transition; not_found means the target is missing and domain_already_active means no transition is needed.",
    tag: "Domains",
    platformScope: "platform:write",
    kind: "write",
    parameters: domainParameters,
    responses: standardResponses(
      {},
      {
        200: { description: "Domain", content: json(domainSchema) },
        ...problemResponses(400, 404, 409),
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
      await service.deleteOrganizationDomain(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        context.req.param("domainId")!,
      );
      return context.body(null, 204);
    },
  );
  registerRoute(
    app,
    routes.listOrganizationDomains,
    validate("param", paramSchema),
    validate("query", querySchema),
    async (context) =>
      context.json(
        await service.listDomains(
          context.get("db"),
          context.req.param("organizationId")!,
          querySchema.parse(context.req.query()),
        ),
      ),
  );
  registerRoute(
    app,
    routes.createOrganizationDomain,
    validate("param", paramSchema),
    validate("json", createSchema),
    async (context) =>
      context.json(
        await service.createDomain(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          createSchema.parse(await context.req.json()),
        ),
        201,
      ),
  );
  registerRoute(
    app,
    routes.disableOrganizationDomain,
    validate("param", domainParams),
    async (context) =>
      context.json(
        await service.disableDomain(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("domainId")!,
        ),
      ),
  );
  registerRoute(
    app,
    routes.enableOrganizationDomain,
    validate("param", domainParams),
    async (context) =>
      context.json(
        await service.enableDomain(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("domainId")!,
        ),
      ),
  );
}
