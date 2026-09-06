import type { Hono } from "hono";
import { resolver } from "hono-openapi";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
const json = (schema: z.ZodType) => ({
  "application/json": { schema: resolver(schema) },
});
const page = (schema: z.ZodType) =>
  z.object({ items: z.array(schema), nextCursor: z.uuid().nullable() });
const parameters = (names: string[]) =>
  names.map((name) => ({
    in: "path" as const,
    name,
    required: true,
    schema: { type: "string" as const, format: "uuid" },
  }));
import * as service from "../../services/users.ts";
import { userStatuses } from "../../db/schema/vocabulary.ts";
const userSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  status: z.enum(userStatuses),
  disabledAt: z.iso.datetime().nullable(),
  retiredEmail: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const detailSchema = userSchema.extend({
  memberships: z.array(
    z.object({
      memberId: z.uuid(),
      organizationId: z.uuid(),
      slug: z.string(),
      validFrom: z.iso.datetime().nullable(),
      validUntil: z.iso.datetime().nullable(),
      effective: z.boolean(),
    }),
  ),
  accounts: z.array(
    z.object({
      issuer: z.string(),
      providerId: z.string(),
      directoryId: z.string().nullable(),
      directoryUserId: z.string().nullable(),
    }),
  ),
  sessionCount: z.number().int(),
});
const querySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(userStatuses).optional(),
  organization: z.uuid().optional(),
});
const userParams = z.object({ userId: z.uuid() });
const eraseSchema = z.object({ confirm: z.uuid() });
export const routes = {
  listUsers: {
    method: "get",
    path: "/users",
    operationId: "listUsers",
    summary: "List users",
    tag: "Users",
    platformScope: "platform:read",
    kind: "read",
    parameters: parameters([]),
    paginated: true,
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(page(userSchema)) },
        ...problemResponses(400, 404),
      },
    ),
  },
  getUser: {
    method: "get",
    path: "/users/:userId",
    operationId: "getUser",
    summary: "Get user",
    tag: "Users",
    platformScope: "platform:read",
    kind: "read",
    parameters: parameters(["userId"]),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(detailSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
  disableUser: {
    method: "post",
    path: "/users/:userId/disable",
    operationId: "disableUser",
    summary: "Disable user",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["userId"]),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(userSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  enableUser: {
    method: "post",
    path: "/users/:userId/enable",
    operationId: "enableUser",
    summary: "Enable user",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["userId"]),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(userSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  retireUserEmail: {
    method: "post",
    path: "/users/:userId/retire-email",
    operationId: "retireUserEmail",
    summary: "Retire user email",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["userId"]),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(userSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  eraseUser: {
    method: "delete",
    path: "/users/:userId",
    operationId: "eraseUser",
    summary: "Erase user",
    tag: "Users",
    platformScope: "platform:write",
    kind: "erase",
    parameters: parameters(["userId"]),
    requestBody: {
      required: true,
      content: { "application/json": { schema: z.toJSONSchema(eraseSchema) } },
    } as AdminRoute["requestBody"],
    example: { body: { confirm: "00000000-0000-7000-8000-000000000000" } },
    responses: standardResponses(
      {},
      { 204: { description: "Success" }, ...problemResponses(400, 404) },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listUsers,
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await service.listUsers(context.get("db"), {
          ...query,
          organizationId: query.organization,
        }),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.getUser,
    validate("param", userParams),
    async (context) => {
      return context.json(
        await service.getUser(context.get("db"), context.req.param("userId")!),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.disableUser,
    validate("param", userParams),
    async (context) => {
      return context.json(
        await service.disableUser(
          context.get("db"),
          actorFromContext(context),
          context.req.param("userId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.enableUser,
    validate("param", userParams),
    async (context) => {
      return context.json(
        await service.enableUser(
          context.get("db"),
          actorFromContext(context),
          context.req.param("userId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.retireUserEmail,
    validate("param", userParams),
    async (context) => {
      return context.json(
        await service.retireUserEmail(
          context.get("db"),
          actorFromContext(context),
          context.req.param("userId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.eraseUser,
    validate("param", userParams),
    validate("json", eraseSchema),
    async (context) => {
      await service.eraseUser(
        context.get("db"),
        actorFromContext(context),
        context.req.param("userId")!,
        eraseSchema.parse(await context.req.json()).confirm,
      );
      return context.body(null, 204);
    },
  );
}
