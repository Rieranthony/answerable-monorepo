import { commandJson } from "./schemas.ts";
import { platformRead } from "./platform-read.ts";
import { pathParameter, uuidParam, confirmQuery } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  platformCommand,
  platformUsersCommand,
  operationJson,
  idempotencyParameter,
  commandResponseHeaders,
} from "./command.ts";
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
    freshAuthentication: false,
    parameters: [],
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: commandJson(page(userSchema)) },
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
    freshAuthentication: false,
    parameters: ["userId"].map((name) => pathParameter(name, "uuid")),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: commandJson(detailSchema) },
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
      "Requires Idempotency-Key. Authorised retries return the receipt without repeating effects. Changed-input reuse conflicts. Disable the user, revoke sessions and tokens and return the updated user. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input. Prefer removeMember to offboard from only one organisation; not_found means the user is missing. A new command reconciles remaining sessions, tokens and grant contexts even when the user is already disabled; only zero actual effects and unchanged status record a noop. Replaying an old key returns its receipt without performing a new reconciliation.",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [pathParameter("userId", "uuid"), idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: commandResponseHeaders,
          content: commandJson(userSchema),
        },
        ...problemResponses(400, 404, 409, 503),
      },
    ),
  },
  enableUser: {
    method: "post",
    path: "/users/:userId/enable",
    operationId: "enableUser",
    summary: "Enable user",
    description:
      "Requires Idempotency-Key. Authorised retries return the receipt without repeating effects. Changed-input reuse conflicts. Enable a disabled user and return the updated user without restoring revoked sessions. Prefer getUser to inspect blockers; not_found, user_email_retired and user_inert identify missing users or states that cannot be enabled.",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [pathParameter("userId", "uuid"), idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: commandResponseHeaders,
          content: commandJson(userSchema),
        },
        ...problemResponses(400, 404, 409, 503),
      },
    ),
  },
  retireUserEmail: {
    method: "post",
    path: "/users/:userId/retire-email",
    operationId: "retireUserEmail",
    summary: "Retire user email",
    description:
      "Requires Idempotency-Key. Authorised retries return the receipt without repeating effects. Changed-input reuse conflicts. Replace a disabled user’s email with a tombstone and return the updated user, freeing the original email for reuse. Prefer disableUser for reversible offboarding; not_found and user_not_disabled identify missing users or invalid lifecycle states.",
    tag: "Users",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [pathParameter("userId", "uuid"), idempotencyParameter],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: commandResponseHeaders,
          content: commandJson(userSchema),
        },
        ...problemResponses(400, 404, 409, 503),
      },
    ),
  },
  eraseUser: {
    method: "delete",
    path: "/users/:userId",
    operationId: "eraseUser",
    summary: "Erase user",
    description:
      "Requires Idempotency-Key. Authorised retries return the receipt without repeating effects. Changed-input reuse conflicts. Soft-delete the profile, account bindings, memberships, assignments, owned clients, links, consents and sent invitations. Clear account/client credentials, revoke grant contexts and delete affected session/token rows. Return no content. Concurrent writes through owned clients, memberships, sessions and refresh tokens are ordered before actual deletion and reference-clearing effects are captured. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableUser for reversible offboarding. Product deletion retains rows with terminal deletedAt markers; identifying data can remain. Ordinary reads and authority exclude deleted rows. Enabling cannot restore them. Physical cleanup and its retention period are deferred.",
    tag: "Users",
    platformScope: "platform:write",
    kind: "erase",
    freshAuthentication: true,
    parameters: [
      ...["userId"].map((name) => pathParameter(name, "uuid")),
      confirmQuery(eraseSchema.shape.confirm),
      idempotencyParameter,
    ],
    example: { query: { confirm: "00000000-0000-7000-8000-000000000000" } },
    responses: standardResponses(
      {},
      {
        204: { description: "Success", headers: commandResponseHeaders },
        ...problemResponses(400, 404, 409, 503),
      },
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
        await platformRead(context, (platform) =>
          service.listUsers(platform, query),
        ),
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
        await platformRead(context, (platform) =>
          service.getUser(platform, context.req.param("userId")!),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.disableUser,
    validate("param", userParams),
    async (context) => {
      const userId = context.req.param("userId")!;
      return platformUsersCommand(
        context,
        "disableUser",
        operationJson({ userId }),
        200,
        async (platform) => {
          const result = await service.disableUser(platform, userId);
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "user", id: userId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.enableUser,
    validate("param", userParams),
    async (context) => {
      const userId = context.req.param("userId")!;
      return platformUsersCommand(
        context,
        "enableUser",
        operationJson({ userId }),
        200,
        async (platform) => {
          const result = await service.enableUser(platform, userId);
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "user", id: userId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.retireUserEmail,
    validate("param", userParams),
    async (context) => {
      const userId = context.req.param("userId")!;
      return platformUsersCommand(
        context,
        "retireUserEmail",
        operationJson({ userId }),
        200,
        async (platform) => {
          const result = await service.retireUserEmail(platform, userId);
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "user", id: userId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.eraseUser,
    validate("param", userParams),
    validate("query", eraseSchema),
    async (context) => {
      const userId = context.req.param("userId")!;
      const confirm = eraseSchema.parse(context.req.query()).confirm;
      return platformCommand(
        context,
        "eraseUser",
        operationJson({ userId, confirm }),
        204,
        async (platform) => {
          await service.eraseUser(platform, userId, confirm);
          return { body: null, resultReference: { type: "user", id: userId } };
        },
      );
    },
  );
}
