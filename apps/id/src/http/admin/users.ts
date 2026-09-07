import { json, pathParameter, uuidParam, confirmQuery } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { actorFromContext } from "../../services/actor.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
const page = (schema: z.ZodType) =>
  z.object({ items: z.array(schema), nextCursor: z.uuid().nullable() });
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
  email: z.email().toLowerCase().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(userStatuses).optional(),
  organizationId: z.uuid().optional(),
});
const userParams = uuidParam("userId");
const eraseSchema = uuidParam("confirm");
export const routes = {
  listUsers: {
    method: "get",
    path: "/users",
    operationId: "listUsers",
    summary: "List users",
    description:
      "Return a cursor page of users, without changing state. Prefer getUser for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors.",
    tag: "Users",
    platformScope: "platform:read",
    kind: "read",
    parameters: [],
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
    description:
      "Return the user, organisation memberships, identity-provider accounts and session count without changing state. Prefer listUsers to discover an id; validation_failed rejects malformed ids and not_found means the user is missing.",
    tag: "Users",
    platformScope: "platform:read",
    kind: "read",
    parameters: ["userId"].map((name) => pathParameter(name, "uuid")),
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
    description:
      "Disable the user, revoke sessions and tokens and return the updated user. Prefer removeMember to offboard from only one organisation; not_found means the user is missing and user_already_disabled means no transition is needed.",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    parameters: ["userId"].map((name) => pathParameter(name, "uuid")),
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
    description:
      "Enable a disabled user and return the updated user without restoring revoked sessions. Prefer getUser to inspect blockers; not_found, user_already_active, user_email_retired and user_inert identify missing users or states that cannot be enabled.",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    parameters: ["userId"].map((name) => pathParameter(name, "uuid")),
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
    description:
      "Replace a disabled user’s email with a tombstone and return the updated user, freeing the original email for reuse. Prefer disableUser for reversible offboarding; not_found, user_not_disabled and user_email_already_retired identify missing users or invalid lifecycle states.",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    parameters: ["userId"].map((name) => pathParameter(name, "uuid")),
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
    description:
      "Permanently erase the user and return no content; related identity records are also deleted. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableUser for reversible offboarding.",
    tag: "Users",
    platformScope: "platform:write",
    kind: "erase",
    parameters: [
      ...["userId"].map((name) => pathParameter(name, "uuid")),
      confirmQuery(eraseSchema.shape.confirm),
    ],
    example: { query: { confirm: "00000000-0000-7000-8000-000000000000" } },
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
        await service.listUsers(context.get("db"), query),
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
    validate("query", eraseSchema),
    async (context) => {
      await service.eraseUser(
        context.get("db"),
        actorFromContext(context),
        context.req.param("userId")!,
        eraseSchema.parse(context.req.query()).confirm,
      );
      return context.body(null, 204);
    },
  );
}
