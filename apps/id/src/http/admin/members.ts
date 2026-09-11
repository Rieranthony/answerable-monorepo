import { tenantRead } from "./tenant-read.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import {
  json,
  body,
  pathParameter,
  uuidParam,
  windowSchema,
  windowDates,
} from "./schemas.ts";
import * as service from "../../services/members.ts";
import type { Hono } from "hono";
import {
  tenantMemberCommand,
  idempotencyParameter,
  commandResponseHeaders,
  operationJson,
} from "./command.ts";
import { z } from "zod";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import {
  membershipStatuses,
  userStatuses,
} from "../../db/schema/vocabulary.ts";
const page = (schema: z.ZodType) =>
  z.object({ items: z.array(schema), nextCursor: z.uuid().nullable() });
const orgParams = uuidParam("organizationId");
export const memberSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  organizationId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  name: z.string(),
  status: z.enum(userStatuses),
  membershipStatus: z.enum(membershipStatuses),
  revokedAt: z.iso.datetime().nullable(),
  validFrom: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  effective: z.boolean(),
});
const detailSchema = memberSchema.extend({
  groups: z.array(
    z.object({
      groupId: z.uuid(),
      slug: z.string(),
      name: z.string(),
      validFrom: z.iso.datetime().nullable(),
      validUntil: z.iso.datetime().nullable(),
    }),
  ),
});
const configurationSchema = memberSchema.pick({
  id: true,
  revision: true,
  organizationId: true,
  userId: true,
  membershipStatus: true,
  revokedAt: true,
  validFrom: true,
  validUntil: true,
});
const querySchema = pageQuerySchema.extend({
  email: z.email().toLowerCase().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  effective: z.enum(["true", "false"]).optional(),
});
const patchSchema = windowSchema.refine(
  (input) => Object.keys(input).length > 0,
  "At least one field is required",
);
const memberParams = orgParams.extend({ memberId: z.uuid() });
export const routes = {
  getMemberConfiguration: {
    method: "get",
    path: "/organizations/:organizationId/members/:memberId/configuration",
    operationId: "getMemberConfiguration",
    summary: "Read member configuration",
    description:
      "Read the stable membership identity, lifecycle and validity window with its strong ETag for If-Match on updateMember. Requires member administration authority. Excludes global profile, groups and time-dependent effective access. validation_failed rejects malformed IDs; not_found means the target is unavailable.",
    tag: "Members",
    platformScope: "platform:users",
    orgScope: "org:users",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: {
          description: "Member configuration",
          content: json(configurationSchema),
          headers: revisionResponseHeaders,
        },
        ...problemResponses(400, 404),
      },
    ),
  },

  listMembers: {
    method: "get",
    path: "/organizations/:organizationId/members",
    operationId: "listMembers",
    summary: "List organisation members",
    description:
      "Return a cursor page of organisation members, without changing state. Prefer getMember for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors and not_found means the organisation or parent is unavailable.",
    tag: "Members",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId"].map((name) => pathParameter(name, "uuid")),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(page(memberSchema)) },
        ...problemResponses(400, 404),
      },
    ),
  },
  getMember: {
    method: "get",
    path: "/organizations/:organizationId/members/:memberId",
    operationId: "getMember",
    summary: "Get an organisation member",
    description:
      "Return an organisation member with group memberships without changing state. Prefer getUser for the global user record; validation_failed rejects malformed ids and not_found means the member or organisation is unavailable.",
    tag: "Members",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(detailSchema) },
        ...problemResponses(400, 404),
      },
    ),
  },
  updateMember: {
    method: "patch",
    path: "/organizations/:organizationId/members/:memberId",
    operationId: "updateMember",
    summary: "Update a member window",
    description:
      "Requires Idempotency-Key and optionally the If-Match ETag from getMemberConfiguration. Stale supplied revisions return 412. A committed replay is recovered before checking the old revision. The response includes the current member revision; read getMemberConfiguration for the next ETag. Identical authorised retries recover the original result for seven days without repeating the mutation or its audit event. Changed input returns idempotency_key_reused; expired recovery returns operation_result_expired and never reruns the command. Change a member’s validity window and return the member with group memberships, affecting when organisation access is effective. Prefer removeMember for offboarding; validation_failed rejects an empty or malformed patch, not_found means the member or organisation is unavailable, and constraint_violation rejects an invalid validity window.",
    tag: "Members",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      idempotencyParameter,
      revisionParameter,
      ...["organizationId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
    ],
    orgScope: "org:users",
    requestBody: body(patchSchema),
    example: { body: { validUntil: null } },
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: {
          description: "Success",
          content: json(detailSchema),
          headers: commandResponseHeaders,
        },
        ...problemResponses(400, 404, 409, 410, 412, 503),
      },
    ),
  },
  reinstateMember: {
    method: "post",
    path: "/organizations/:organizationId/members/:memberId/reinstate",
    operationId: "reinstateMember",
    summary: "Reinstate an organisation member",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating the mutation or its audit event. Changed input returns idempotency_key_reused; expired recovery returns operation_result_expired and never reruns the command. Explicitly reactivate a revoked membership, preserving its UUID and validity window. Removed direct grants and group assignments are not restored. Already active memberships return unchanged state with an audit event. validation_failed rejects malformed IDs and not_found means the member is unavailable. ",
    tag: "Members",
    platformScope: "platform:users",
    orgScope: "org:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      idempotencyParameter,
      ...["organizationId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
    ],
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: {
          description: "Membership reinstated",
          headers: commandResponseHeaders,
          content: json(detailSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  removeMember: {
    method: "delete",
    path: "/organizations/:organizationId/members/:memberId",
    operationId: "removeMember",
    summary: "Remove an organisation member",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating the mutation or its audit event. Changed input returns idempotency_key_reused; expired recovery returns operation_result_expired and never reruns the command. Revoke an organisation membership and return no content. Retain its UUID and revoked state to prevent automatic SSO re-enrolment; remove its direct grants and group assignments. The global user and other memberships remain. Repeating removal records an unchanged event. Prefer updateMember to change its validity or scopes; validation_failed rejects malformed ids and not_found means the target is unavailable.",
    tag: "Members",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      idempotencyParameter,
      ...["organizationId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
    ],
    orgScope: "org:users",
    responses: standardResponses(
      { orgScope: "org:users" },
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
    routes.getMemberConfiguration,
    validate("param", memberParams),
    async (context) => {
      const body = await tenantRead(context, "configuration", (tenant) =>
        service.getMemberConfiguration(tenant, context.req.param("memberId")!),
      );
      context.header("ETag", revisionTag(body));
      return context.json(body);
    },
  );

  registerRoute(
    app,
    routes.reinstateMember,
    validate("param", memberParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const memberId = context.req.param("memberId")!;
      return tenantMemberCommand(
        context,
        "reinstateMember",
        organizationId,
        { memberId },
        200,
        async (tenant) => {
          const before = await service.getMemberConfiguration(tenant, memberId);
          const body = await service.reinstate(tenant, memberId);
          return {
            body,
            outcome: before.membershipStatus === "active" ? "noop" : "applied",
            resultReference: { type: "member", id: memberId },
          };
        },
      );
    },
  );

  registerRoute(
    app,
    routes.listMembers,
    validate("param", orgParams),
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await tenantRead(context, "directory", (tenant) =>
          service.listMembers(tenant, {
            ...query,
            effective:
              query.effective === undefined
                ? undefined
                : query.effective === "true",
          }),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.getMember,
    validate("param", memberParams),
    async (context) => {
      return context.json(
        await tenantRead(context, "directory", (tenant) =>
          service.getMember(tenant, context.req.param("memberId")!),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.updateMember,
    validate("param", memberParams),
    validate("json", patchSchema),
    async (context) => {
      const expected = requireRevision(context.req.header("If-Match"));
      const patch = windowDates(patchSchema.parse(await context.req.json()));
      const organizationId = context.req.param("organizationId")!;
      const memberId = context.req.param("memberId")!;
      return tenantMemberCommand(
        context,
        "updateMember",
        organizationId,
        operationJson({ memberId, patch, expected }),
        200,
        async (tenant) => {
          const { body, changed } = await service.updateWindow(
            tenant,
            memberId,
            patch,
            expected,
          );
          return {
            body,
            outcome: changed ? "applied" : "noop",
            resultReference: { type: "member", id: memberId },
          };
        },
      );
    },
  );
  registerRoute(
    app,
    routes.removeMember,
    validate("param", memberParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const memberId = context.req.param("memberId")!;
      return tenantMemberCommand(
        context,
        "removeMember",
        organizationId,
        { memberId },
        204,
        async (tenant) => {
          const outcome = await service.remove(tenant, memberId);
          return {
            body: null,
            outcome,
            resultReference: { type: "member", id: memberId },
          };
        },
      );
    },
  );
}
