import { json, pathParameter, uuidParam } from "./schemas.ts";
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
import * as service from "../../services/sessions.ts";
const sessionSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  activeOrganizationId: z.uuid().nullable(),
});
const revokedSchema = z.object({ revoked: z.number().int() });
const userParams = uuidParam("userId");
const sessionParams = userParams.extend({ sessionId: z.uuid() });
const memberParams = z.object({ organizationId: z.uuid(), memberId: z.uuid() });
export const routes = {
  listUserSessions: {
    method: "get",
    path: "/users/:userId/sessions",
    operationId: "listUserSessions",
    summary: "List user sessions",
    description:
      "Return a cursor page of the user’s sessions without changing state. Prefer listMemberSessions when working through an organisation membership; validation_failed rejects invalid ids or pagination and not_found means the user is missing.",
    tag: "Sessions",
    platformScope: "platform:read",
    kind: "read",
    parameters: ["userId"].map((name) => pathParameter(name, "uuid")),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(page(sessionSchema)) },
        ...problemResponses(400, 404),
      },
    ),
  },
  revokeUserSessions: {
    method: "delete",
    path: "/users/:userId/sessions",
    operationId: "revokeUserSessions",
    summary: "Revoke user sessions",
    description:
      "Revoke all of the user’s sessions and tokens and return an object containing the revoked session count. Prefer revokeUserSession to end only one session; validation_failed rejects malformed ids and not_found means the user is missing.",
    tag: "Sessions",
    platformScope: "platform:users",
    kind: "write",
    parameters: ["userId"].map((name) => pathParameter(name, "uuid")),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(revokedSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
  revokeUserSession: {
    method: "delete",
    path: "/users/:userId/sessions/:sessionId",
    operationId: "revokeUserSession",
    summary: "Revoke user session",
    description:
      "Revoke one user session and its associated tokens and return no content. Prefer revokeUserSessions to revoke every session and token for that user; validation_failed rejects malformed ids and not_found means the user or session is missing.",
    tag: "Sessions",
    platformScope: "platform:users",
    kind: "write",
    parameters: ["userId", "sessionId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      {},
      { 204: { description: "Success" }, ...problemResponses(400, 404) },
    ),
  },
  listMemberSessions: {
    method: "get",
    path: "/organizations/:organizationId/members/:memberId/sessions",
    operationId: "listMemberSessions",
    summary: "List member sessions",
    description:
      "Return a cursor page of the member’s underlying user sessions across organisations without changing state. Prefer listUserSessions when you have the global user id; validation_failed rejects invalid ids or pagination and not_found means the member is unavailable.",
    tag: "Sessions",
    platformScope: "platform:read",
    kind: "read",
    parameters: ["organizationId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:users",
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: { description: "Success", content: json(page(sessionSchema)) },
        ...problemResponses(400, 404),
      },
    ),
  },
  revokeMemberSessions: {
    method: "delete",
    path: "/organizations/:organizationId/members/:memberId/sessions",
    operationId: "revokeMemberSessions",
    summary: "Revoke member sessions",
    description:
      "Revoke all sessions and tokens for the member’s underlying user across organisations and return an object containing the revoked session count. Prefer removeMember to offboard only from this organisation; validation_failed rejects malformed ids and not_found means the member is unavailable.",
    tag: "Sessions",
    platformScope: "platform:users",
    kind: "write",
    parameters: ["organizationId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:users",
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: { description: "Success", content: json(revokedSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listUserSessions,
    validate("param", userParams),
    validate("query", pageQuerySchema),
    async (context) => {
      return context.json(
        await service.listUserSessions(
          context.get("db"),
          context.req.param("userId")!,
          pageQuerySchema.parse(context.req.query()),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.revokeUserSessions,
    validate("param", userParams),
    async (context) => {
      return context.json(
        await service.revokeUserSessions(
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
    routes.revokeUserSession,
    validate("param", sessionParams),
    async (context) => {
      await service.revokeUserSession(
        context.get("db"),
        actorFromContext(context),
        context.req.param("userId")!,
        context.req.param("sessionId")!,
      );
      return context.body(null, 204);
    },
  );
  registerRoute(
    app,
    routes.listMemberSessions,
    validate("param", memberParams),
    validate("query", pageQuerySchema),
    async (context) => {
      return context.json(
        await service.listMemberSessions(
          context.get("db"),
          context.req.param("organizationId")!,
          context.req.param("memberId")!,
          pageQuerySchema.parse(context.req.query()),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.revokeMemberSessions,
    validate("param", memberParams),
    async (context) => {
      return context.json(
        await service.revokeMemberSessions(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("memberId")!,
        ),
        200,
      );
    },
  );
}
