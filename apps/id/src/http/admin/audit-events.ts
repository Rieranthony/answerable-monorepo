import type { Hono } from "hono";
import { resolver } from "hono-openapi";
import { z } from "zod";
import { auditActorTypes, auditOutcomes } from "../../db/schema/vocabulary.ts";
import * as service from "../../services/audit.ts";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";

const querySchema = pageQuerySchema.extend({
  actor: z.string().optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
const platformQuerySchema = querySchema.extend({
  organization: z.uuid().optional(),
});
const params = z.object({ organizationId: z.uuid() });
const auditSchema = z.object({
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
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
});
const responses = standardResponses(
  {},
  {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: resolver(
            z.object({
              items: z.array(auditSchema),
              nextCursor: z.uuid().nullable(),
            }),
          ),
        },
      },
    },
    ...problemResponses(400),
  },
);
export const routes = {
  listAuditEvents: {
    method: "get",
    path: "/audit-events",
    operationId: "listAuditEvents",
    summary: "List audit events",
    tag: "Audit",
    platformScope: "platform:read",
    kind: "read",
    paginated: true,
    responses,
  },
  listOrganizationAuditEvents: {
    method: "get",
    path: "/organizations/:organizationId/audit-events",
    operationId: "listOrganizationAuditEvents",
    summary: "List organisation audit events",
    tag: "Audit",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    paginated: true,
    responses: { ...responses, ...problemResponses(404) },
    parameters: [
      {
        in: "path",
        name: "organizationId",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
    ],
  },
} satisfies Record<string, AdminRoute>;
function filters(query: z.output<typeof platformQuerySchema>) {
  return {
    organizationId: query.organization,
    actorId: query.actor,
    action: query.action,
    targetType: query.targetType,
    targetId: query.targetId,
    from: query.from === undefined ? undefined : new Date(query.from),
    to: query.to === undefined ? undefined : new Date(query.to),
  };
}
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listAuditEvents,
    validate("query", platformQuerySchema),
    async (context) => {
      const query = platformQuerySchema.parse(context.req.query());
      return context.json(
        await service.listAuditEvents(context.get("db"), filters(query), query),
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
        await service.listOrganizationAuditEvents(
          context.get("db"),
          context.req.param("organizationId")!,
          filters(query),
          query,
        ),
      );
    },
  );
}
