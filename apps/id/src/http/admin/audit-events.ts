import { platformRead } from "./platform-read.ts";
import { tenantRead } from "./tenant-read.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";
import type { Hono } from "hono";
import { z } from "zod";
import { auditActorTypes, auditOutcomes } from "../../db/schema/vocabulary.ts";
import { listAuditEvents } from "../../db/queries/audit.ts";
import * as service from "../../services/audit.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";

const querySchema = pageQuerySchema.extend({
  operationId: z.uuid().optional(),
  actorId: z.string().optional(),
  action: z.string().optional(),
  outcome: z.enum(auditOutcomes).optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
const userQuerySchema = querySchema.omit({
  operationId: true,
  actorId: true,
  targetType: true,
  targetId: true,
});
const platformQuerySchema = querySchema.extend({
  organizationId: z.uuid().optional(),
});
const params = uuidParam("organizationId");
const auditSchema = z.object({
  operationId: z.uuid().nullable(),
  schemaVersion: z
    .number()
    .int()
    .describe(
      "1 for every event. Each action has one data shape, listed per action in the Answerable ID schema document.",
    ),
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  actorType: z.enum(auditActorTypes),
  actorId: z.string(),
  organizationId: z.uuid().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  outcome: z.enum(auditOutcomes),
  reason: z.string().nullable(),
  requestId: z.string().nullable(),
  ip: z
    .string()
    .nullable()
    .describe(
      "The client address resolved from X-Forwarded-For through the trusted proxies, for events written while serving a request; otherwise null. Descriptive metadata, never proof of client origin.",
    ),
  userAgent: z
    .string()
    .nullable()
    .describe(
      "Caller-supplied descriptive metadata, never identity: 1–512 printable ASCII characters, otherwise null.",
    ),
  data: z.record(z.string(), z.unknown()).nullable(),
});
const responses = {
  200: {
    description: "Success",
    content: json(
      z.object({
        items: z.array(auditSchema),
        nextCursor: z.uuid().nullable(),
      }),
    ),
  },
  ...problemResponses(400),
};
export const routes = {
  listUserAuditEvents: {
    method: "get",
    path: "/users/:userId/audit-events",
    operationId: "listUserAuditEvents",
    summary: "List user audit events",
    description:
      "Return the events that concern a person, newest first, without changing state: as actor; as the user, membership, group-membership, session or grant target; as an entitlement's member; or named in an event's effects. Filter by action, outcome, from or to and continue with limit and cursor. Prefer listAuditEvents for a platform-wide review; not_found means neither a live user nor retained user history exists and validation_failed rejects invalid ids, filters or cursors.",
    tag: "Audit",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters: [pathParameter("userId", "uuid")],
    responses: { ...responses, ...problemResponses(404) },
  },
  listAuditEvents: {
    method: "get",
    path: "/audit-events",
    operationId: "listAuditEvents",
    summary: "List audit events",
    description:
      "Return a cursor page of audit events, without changing state. Filter by operationId to trace a journalled command. Interpret data with action; operationId is null for unlinked events. Prefer listOrganizationAuditEvents for one organisation and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors.",
    tag: "Audit",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    responses,
  },
  listOrganizationAuditEvents: {
    method: "get",
    path: "/organizations/:organizationId/audit-events",
    operationId: "listOrganizationAuditEvents",
    summary: "List organisation audit events",
    description:
      "Return a cursor page of organisation-visible audit events, without changing state. Client-resource link actions appear only when the resource is platform-shared or owned by this organisation. Filter by operationId to trace a journalled command within this organisation. Prefer listAuditEvents for a platform-wide review and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors and not_found means neither a live organisation nor retained organisation history exists.",
    tag: "Audit",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    responses: { ...responses, ...problemResponses(404) },
    parameters: [pathParameter("organizationId", "uuid")],
  },
} satisfies Record<string, AdminRoute>;
function filters(query: z.output<typeof platformQuerySchema>) {
  return {
    organizationId: query.organizationId,
    operationId: query.operationId,
    actorId: query.actorId,
    action: query.action,
    outcome: query.outcome,
    targetType: query.targetType,
    targetId: query.targetId,
    from: query.from === undefined ? undefined : new Date(query.from),
    to: query.to === undefined ? undefined : new Date(query.to),
  };
}
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listUserAuditEvents,
    validate("param", uuidParam("userId")),
    validate("query", userQuerySchema),
    async (context) => {
      const query = userQuerySchema.parse(context.req.query());
      return context.json(
        await platformRead(context, (platform) =>
          service.listUserAuditEvents(
            platform,
            context.req.param("userId")!,
            filters(query),
            query,
          ),
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.listAuditEvents,
    validate("query", platformQuerySchema),
    async (context) => {
      const query = platformQuerySchema.parse(context.req.query());
      return context.json(
        await platformRead(context, (platform) =>
          listAuditEvents(platform, filters(query), query),
        ),
      );
    },
  );
  registerRoute(
    app,
    routes.listOrganizationAuditEvents,
    validate("param", params),
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await tenantRead(context, "history", (tenant) =>
          service.listOrganizationAuditEvents(tenant, filters(query), query),
        ),
      );
    },
  );
}
