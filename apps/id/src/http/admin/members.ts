import {
  commandJson,
  json,
  body,
  pathParameter,
  uuidParam,
  windowSchema,
  windowDates,
  pageSchema,
} from "./schemas.ts";
import { tenantRead } from "./tenant-read.ts";
import {
  requireRevision,
  revisionTag,
  revisionParameter,
  revisionResponseHeaders,
} from "./revision.ts";
import { listMembers } from "../../db/queries/members.ts";
import * as service from "../../services/members.ts";
import {
  importMembers,
  importRefusals,
  maxImportAddresses,
} from "../../services/member-import.ts";
import type { Hono } from "hono";
import { platformCommand, tenantMemberCommand } from "./command.ts";
import { z } from "zod";
import type { AppEnvironment } from "../context.ts";
import { pageQuerySchema } from "../pagination.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import {
  membershipStatuses,
  userStatuses,
} from "../../db/schema/vocabulary.ts";
const orgParams = uuidParam("organizationId");
const memberSchema = z.object({
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
const importSchema = z.object({
  addresses: z.array(z.string()).min(1).max(maxImportAddresses),
});
const importAnswerSchema = z.object({
  counts: z.object({
    created: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    alreadyMember: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
  }),
  items: z.array(
    z.object({
      address: z.string(),
      outcome: z.enum(["created", "added", "alreadyMember", "refused"]),
      reason: z.enum(importRefusals).optional(),
    }),
  ),
});
export const routes = {
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
    parameters: ["organizationId"].map((name) => pathParameter(name, "uuid")),
    orgScope: "org:members",
    responses: {
      200: {
        description: "Success",
        content: json(pageSchema(memberSchema)),
      },
      ...problemResponses(400, 404),
    },
  },
  getMember: {
    method: "get",
    path: "/organizations/:organizationId/members/:memberId",
    operationId: "getMember",
    summary: "Get an organisation member",
    description:
      "Return an organisation member with group memberships without changing state, with its strong ETag for If-Match on updateMember. Prefer getUser for the global user record; validation_failed rejects malformed ids and not_found means the member or organisation is unavailable.",
    tag: "Members",
    platformScope: "platform:read",
    kind: "read",
    parameters: ["organizationId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:read",
    responses: {
      200: {
        description: "Success",
        content: json(detailSchema),
        headers: revisionResponseHeaders,
      },
      ...problemResponses(400, 404),
    },
  },
  updateMember: {
    method: "patch",
    path: "/organizations/:organizationId/members/:memberId",
    operationId: "updateMember",
    summary: "Update a member window",
    description:
      "Accepts the If-Match ETag from getMember. Stale supplied revisions return 412. A committed replay is recovered before checking the old revision. The response includes the current member revision; read getMember for the next ETag. Change a member’s validity window and return the member with group memberships, affecting when organisation access is effective. Prefer removeMember for offboarding; validation_failed rejects an empty or malformed patch, not_found means the member or organisation is unavailable, and constraint_violation rejects an invalid validity window.",
    tag: "Members",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      revisionParameter,
      ...["organizationId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
    ],
    orgScope: "org:users",
    requestBody: body(patchSchema),
    example: { body: { validUntil: null } },
    responses: {
      200: {
        description: "Success",
        content: commandJson(detailSchema),
      },
      ...problemResponses(404, 412),
    },
  },
  importMembers: {
    method: "post",
    path: "/organizations/:organizationId/members/import",
    operationId: "importMembers",
    summary: "Import organisation members",
    description:
      "Create up to 1,000 people before their first sign-in, so that their sub exists first: a user and an active membership at once, and no account, which the first sign-in makes. Addresses are normalised and de-duplicated. One transaction, answering per address and never all or nothing: created; added, an existing user gains a membership; alreadyMember; or refused with a reason: invalid; outside_domains, not one of this organisation's active domains; disabled, an existing disabled user; removed, a revoked member, whom only reinstateMember brings back; other_firm, an account from another organisation's directory or magic-link row. Works with magic links off and with a directory connected. A replay with the same Idempotency-Key answers the receipt, not the per-address answers; member.imported is audited per membership made. A person's first directory sign-in asks for a code from their mailbox, once, which connects it to this user. validation_failed rejects a malformed or oversized list and not_found means the organisation is missing.",
    tag: "Members",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: ["organizationId"].map((name) => pathParameter(name, "uuid")),
    requestBody: body(importSchema),
    example: {
      body: { addresses: ["ada@acme.example.com", "grace@acme.example.com"] },
    },
    responses: {
      200: { description: "Success", content: commandJson(importAnswerSchema) },
      ...problemResponses(404),
    },
  },
  reinstateMember: {
    method: "post",
    path: "/organizations/:organizationId/members/:memberId/reinstate",
    operationId: "reinstateMember",
    summary: "Reinstate an organisation member",
    description:
      "Explicitly reactivate a revoked membership, preserving its UUID and validity window. Removed direct grants and group assignments are not restored. Already active memberships return unchanged state and record a noop. validation_failed rejects malformed IDs and not_found means the member is unavailable.",
    tag: "Members",
    platformScope: "platform:users",
    orgScope: "org:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
    ],
    responses: {
      200: {
        description: "Membership reinstated",
        content: commandJson(detailSchema),
      },
      ...problemResponses(404),
    },
  },
  removeMember: {
    method: "delete",
    path: "/organizations/:organizationId/members/:memberId",
    operationId: "removeMember",
    summary: "Remove an organisation member",
    description:
      "Revoke an organisation membership and return no content. Retain its UUID and revoked state to prevent automatic SSO re-enrolment; remove its direct grants and group assignments. The global user and other memberships remain. Repeating removal records a noop. Prefer updateMember to change its validity or scopes; validation_failed rejects malformed ids and not_found means the target is unavailable.",
    tag: "Members",
    platformScope: "platform:users",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
    ],
    orgScope: "org:users",
    responses: {
      204: { description: "Success" },
      ...problemResponses(404),
    },
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.importMembers,
    validate("param", orgParams),
    validate("json", importSchema),
    async (context) => {
      const { addresses } = importSchema.parse(await context.req.json());
      const organizationId = context.req.param("organizationId")!;
      return platformCommand(
        context,
        "users",
        { organizationId, addresses },
        200,
        async (platform) => {
          const body = await importMembers(platform, organizationId, addresses);
          const { created, added } = body.counts;
          return {
            body,
            changed: created + added > 0,
            resultReference: { type: "organization", id: organizationId },
          };
        },
      );
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
        organizationId,
        { memberId },
        200,
        async (tenant) => {
          const { row, changed } = await service.reinstate(tenant, memberId);
          return {
            body: row,
            changed,
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
        await tenantRead(context, "members", (tenant) =>
          listMembers(tenant, {
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
      const member = await tenantRead(context, "directory", (tenant) =>
        service.getMember(tenant, context.req.param("memberId")!),
      );
      context.header("ETag", revisionTag(member));
      return context.json(member, 200);
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
        organizationId,
        { memberId, patch, expected },
        200,
        async (tenant) => {
          const { row, changed } = await service.updateWindow(
            tenant,
            memberId,
            patch,
            expected,
          );
          return {
            body: row,
            changed,
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
        organizationId,
        { memberId },
        204,
        async (tenant) => {
          const outcome = await service.remove(tenant, memberId);
          return {
            body: null,
            changed: outcome === "applied",
            resultReference: { type: "member", id: memberId },
          };
        },
      );
    },
  );
}
