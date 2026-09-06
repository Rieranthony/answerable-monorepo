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
const userParams = z.object({ userId: z.uuid() });
const sessionParams = userParams.extend({ sessionId: z.uuid() });
const memberParams = z.object({ organizationId: z.uuid(), memberId: z.uuid() });
export const routes = {
  listUserSessions: {
    method: "get",
    path: "/users/:userId/sessions",
    operationId: "listUserSessions",
    summary: "List user sessions",
    tag: "Sessions",
    platformScope: "platform:read",
    kind: "read",
    parameters: parameters(["userId"]),
    paginated: true,
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
    tag: "Sessions",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["userId"]),
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
    tag: "Sessions",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["userId", "sessionId"]),
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
    tag: "Sessions",
    platformScope: "platform:read",
    kind: "read",
    parameters: parameters(["organizationId", "memberId"]),
    orgScope: "org:users",
    paginated: true,
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
    tag: "Sessions",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["organizationId", "memberId"]),
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
