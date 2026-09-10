import { platformRead } from "./platform-read.ts";
import { tenantRead } from "./tenant-read.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";
import type { Hono } from "hono";
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
      "Interpret with action: 0 is legacy history, 1 is the original event payload, oauth.token.issued version 2 stores the evaluated machine decision under data.decision; oauth.token.rejected version 2 retains the returned machine policy decision, or null before evaluation. oauth.token.rejected version 3 records failed machine-client authentication with a system actor, null tenant/client/decision and authentication stage; supplied identity, credentials, scopes and resource are omitted. Scope denials omit rejected scope values; no eligible capability yields a minimal denial without a target snapshot. An approved decision on a failed attempt is not proof of commit; auth.signin.rejected version 2 records recognised failure categories without free-form descriptions. group.erased version 2 records removed assignments and entitlements under data.effects. group.enabled and group.disabled version 2 retain assignments and entitlements under data.policySources; these are policy sources, not an effective-permission delta. These group events index recorded affected users. Changed group/organisation entitlement events use version 2 with data.audience recording tenant-local membership and group-assignment sources; direct-member and unchanged entitlement events retain version 1. organization.erased version 2 records removed tenant configuration and cleared browser-session organisation selections under data.effects, alongside deletedGrantContexts containing each stored grant ID, user ID and organisation ID. Member and affected-session user UUIDs remain indexed after erasure; provider credentials and invitation email are excluded. Browser sessions are preserved, not revoked. user.erased version 2 records actual global and owned-client cascade effects under data.effects, including safe policy identities, deleted token/consent records, cleared token session references and SSO attribution revision changes. It excludes credentials and account linkage identifiers; affected users remain indexed after erasure. member.updated, member.removed, member.removal_unchanged, member.reinstated and member.reinstatement_unchanged version 2 retain member-access observations under data.before.access and data.after.access. Assigned scopes differ from permission.scopes. These are observations at separate statements, not a causal delta or proof of remote revocation. client.resource_linked, client.resource_unlinked and client.resource_unchanged version 2 retain immutable resource identity/classification/owner. Foreign-private or unknown targets are platform-only; organisation history accepts versions 2 and 3 of these link actions. user.disabled, user.disable_unchanged, session.revoked and session.revoked_all version 2 retain exact changed token row IDs and nullable user IDs under data.revokedTokens.access and data.revokedTokens.refresh. client.grants_revoked version 2 retains the same token manifest alongside grantContexts in platform-only history; owner events retain counts and a grantEffectsEventId reference. Affected-user subjects survive erasure. Token values are excluded; local row revocation is not proof of remote termination. client.grants_erased version 2 records deleted token, consent and client-resource link rows under data.effects in platform-only history, including access tokens cascaded through a deleted refresh token. client.erased version 2 retains owner-safe counts and grantEffectsEventId. Affected users remain indexed after erasure. New user/organisation/group/client deletion events use version 3 with deletionMode soft, terminal deletedAt after-state, softDeleted relationship manifests, deleted session/token manifests and revoked grant contexts. Resource/domain/provider/capability deletion uses version 2; entitlement/group-assignment/member removal uses version 3. Client-resource link version 3 adds the changed relationship UUID and deletedAt; null means no relationship effect. These newer contracts supersede physical-erasure descriptions above; retained older events are not rewritten.",
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
      "Historical metadata may be unverified. New HTTP-originated events leave this null because no trusted ingress address contract is configured. Never use it as proof of client origin.",
    ),
  userAgent: z
    .string()
    .nullable()
    .describe(
      "Caller-supplied descriptive metadata, never identity. New HTTP/session audit values accept only 1–512 printable ASCII characters; other values are omitted. Legacy values may be unbounded.",
    ),
  data: z.record(z.string(), z.unknown()).nullable(),
});
const responses = standardResponses(
  {},
  {
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
  },
);
export const routes = {
  listUserAuditEvents: {
    method: "get",
    path: "/users/:userId/audit-events",
    operationId: "listUserAuditEvents",
    summary: "List user audit events",
    description:
      "Return a person's audit trail as actor or user, membership or session target, newest first, without changing state. Filter by action, outcome, from or to and continue with limit and cursor. Prefer listAuditEvents for a platform-wide review; not_found means neither a live user nor retained user history exists and validation_failed rejects invalid ids, filters or cursors.",
    tag: "Audit",
    platformScope: "platform:read",
    kind: "read",
    parameters: [pathParameter("userId", "uuid")],
    responses: { ...responses, ...problemResponses(404) },
  },
  listAuditEvents: {
    method: "get",
    path: "/audit-events",
    operationId: "listAuditEvents",
    summary: "List audit events",
    description:
      "Return a cursor page of audit events, without changing state. Filter by operationId to trace a journalled command. Interpret schemaVersion with action: 0 is legacy history and supported new event contracts use 1, 2 or 3; operationId is null for unlinked events. Prefer listOrganizationAuditEvents for one organisation and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors.",
    tag: "Audit",
    platformScope: "platform:read",
    kind: "read",
    responses,
  },
  listOrganizationAuditEvents: {
    method: "get",
    path: "/organizations/:organizationId/audit-events",
    operationId: "listOrganizationAuditEvents",
    summary: "List organisation audit events",
    description:
      "Return a cursor page of organisation-visible audit events, without changing state. Client-resource link actions are visible only at versions 2 and 3 and only when scoped to this organisation; legacy or unrecognised link versions remain available through the platform audit endpoint. Filter by operationId to trace a journalled command within this organisation. Prefer listAuditEvents for a platform-wide review and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors and not_found means neither a live organisation nor retained organisation history exists.",
    tag: "Audit",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
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
          service.listAuditEvents(platform, filters(query), query),
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
