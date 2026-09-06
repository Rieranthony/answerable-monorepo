import type { Hono } from "hono";
import { resolver } from "hono-openapi";
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
const domainParams = paramSchema.extend({ domainId: z.uuid() });
const domainParameters = [
  ...parameters,
  {
    in: "path",
    name: "domainId",
    required: true,
    schema: { type: "string", format: "uuid" },
  },
] satisfies AdminRoute["parameters"];

export const routes = {
  listOrganizationDomains: {
    method: "get",
    path: "/organizations/:organizationId/domains",
    operationId: "listOrganizationDomains",
    summary: "List organisation domains",
    tag: "Domains",
    platformScope: "platform:read",
    kind: "read",
    parameters,
    orgScope: "org:read",
    paginated: true,
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
