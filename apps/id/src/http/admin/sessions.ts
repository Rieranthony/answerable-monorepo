import { platformRead } from "./platform-read.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
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
import * as service from "../../services/sessions.ts";
const sessionSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  ipAddress: z
    .string()
    .nullable()
    .describe(
      "New sessions store null. Legacy values are unverified metadata, not proof of client origin.",
    ),
  userAgent: z
    .string()
    .nullable()
    .describe(
      "Caller-supplied descriptive metadata. New sessions accept only 1–512 printable ASCII characters; other values become null. Legacy values may be unbounded.",
    ),
  activeOrganizationId: z.uuid().nullable(),
});
const revokedSchema = z.object({ revoked: z.number().int() });
const userParams = uuidParam("userId");
const sessionParams = userParams.extend({ sessionId: z.uuid() });
export const routes = {
  listUserSessions: {
    method: "get",
    path: "/users/:userId/sessions",
    operationId: "listUserSessions",
    summary: "List user sessions",
    description:
      "Return a cursor page of the user’s sessions without changing state. These are global login sessions, available only to platform administrators; validation_failed rejects invalid ids or pagination and not_found means the user is missing.",
    tag: "Sessions",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
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
      "Requires Idempotency-Key. Authorised retries recover the original result for seven days without revoking later sessions. Live changed-input reuse conflicts; expired recovery never repeats the command. Revoke all of the user’s sessions and tokens and return an object containing the revoked session count. Prefer revokeUserSession to end only one session; validation_failed rejects malformed ids and not_found means the user is missing.",
    tag: "Sessions",
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
          content: json(revokedSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  revokeUserSession: {
    method: "delete",
    path: "/users/:userId/sessions/:sessionId",
    operationId: "revokeUserSession",
    summary: "Revoke user session",
    description:
      "Requires Idempotency-Key. Authorised retries recover the original result for seven days without revoking later sessions. Live changed-input reuse conflicts; expired recovery never repeats the command. Revoke one user session and its associated tokens and return no content. Prefer revokeUserSessions to revoke every session and token for that user; validation_failed rejects malformed ids and not_found means the user or session is missing.",
    tag: "Sessions",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["userId", "sessionId"].map((name) => pathParameter(name, "uuid")),
      idempotencyParameter,
    ],
    responses: standardResponses(
      {},
      {
        204: { description: "Success", headers: commandResponseHeaders },
        ...problemResponses(400, 404, 409, 410, 503),
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
        await platformRead(context, (platform) =>
          service.listUserSessions(
            platform,
            context.req.param("userId")!,
            pageQuerySchema.parse(context.req.query()),
          ),
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
      const userId = context.req.param("userId")!;
      return platformUsersCommand(
        context,
        "revokeUserSessions",
        operationJson({ userId }),
        200,
        async (platform) => {
          const result = await service.revokeUserSessions(platform, userId);
          return {
            body: { revoked: result.revoked },
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "user", id: userId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.revokeUserSession,
    validate("param", sessionParams),
    async (context) => {
      const userId = context.req.param("userId")!;
      const sessionId = context.req.param("sessionId")!;
      return platformUsersCommand(
        context,
        "revokeUserSession",
        operationJson({ userId, sessionId }),
        204,
        async (platform) => {
          await service.revokeUserSession(platform, userId, sessionId);
          return {
            body: null,
            resultReference: { type: "session", id: sessionId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
}
