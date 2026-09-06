import type { Hono } from "hono";
import { resolver } from "hono-openapi";
import { z } from "zod";
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
import { actorFromContext } from "../../services/actor.ts";
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
const eraseSchema = z.object({ confirm: z.uuid() });
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
const success = {
  200: { description: "Organisation", content: json(organizationSchema) },
};

export const routes = {
  listOrganizations: {
    method: "get",
    path: "/organizations",
    operationId: "listOrganizations",
    summary: "List organisations",
    tag: "Organizations",
    platformScope: "platform:read",
    kind: "read",
    paginated: true,
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
    tag: "Organizations",
    platformScope: "platform:write",
    kind: "erase",
    parameters,
    requestBody: body(eraseSchema),
    example: { body: { confirm: "00000000-0000-7000-8000-000000000000" } },
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
    validate("json", eraseSchema),
    async (context) => {
      const { confirm } = eraseSchema.parse(await context.req.json());
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
