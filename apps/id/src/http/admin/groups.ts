import { tenantRead } from "./tenant-read.ts";
import {
  requireRevision,
  requirePutRevision,
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
  confirmQuery,
} from "./schemas.ts";
import * as service from "../../services/groups.ts";
import type { Hono } from "hono";
import { z } from "zod";
import {
  platformCommand,
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
import { lifecycleStatuses } from "../../db/schema/vocabulary.ts";
const page = (schema: z.ZodType) =>
  z.object({ items: z.array(schema), nextCursor: z.uuid().nullable() });
const orgParams = uuidParam("organizationId");
export const groupSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  organizationId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  externalId: z.string().nullable(),
  status: z.enum(lifecycleStatuses),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const membershipSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  organizationId: z.uuid(),
  groupId: z.uuid(),
  memberId: z.uuid(),
  validFrom: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
const groupMemberSchema = z.object({
  memberId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  name: z.string(),
  validFrom: z.iso.datetime().nullable(),
  validUntil: z.iso.datetime().nullable(),
  effective: z.boolean(),
});
const querySchema = pageQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(lifecycleStatuses).optional(),
});
const createSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1).max(200),
  externalId: z.string().min(1).max(200).optional(),
});
const patchSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    externalId: z.string().min(1).max(200).nullable().optional(),
  })
  .refine(
    (input) => Object.keys(input).length > 0,
    "At least one field is required",
  );
const eraseSchema = uuidParam("confirm");
const groupParams = orgParams.extend({ groupId: z.uuid() });
const memberParams = groupParams.extend({ memberId: z.uuid() });
export const routes = {
  listGroups: {
    method: "get",
    path: "/organizations/:organizationId/groups",
    operationId: "listGroups",
    summary: "List organisation groups",
    description:
      "Return a cursor page of organisation groups, without changing state. Prefer getGroup for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors and not_found means the organisation or parent is unavailable.",
    tag: "Groups",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId"].map((name) => pathParameter(name, "uuid")),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(page(groupSchema)) },
        ...problemResponses(400, 404),
      },
    ),
  },
  createGroup: {
    method: "post",
    path: "/organizations/:organizationId/groups",
    operationId: "createGroup",
    summary: "Create an organisation group",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects; live changed-input reuse conflicts and expired recovery never executes again. Create an organisation group and return the created record, recording the change in the audit log. Prefer getGroup to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId"].map((name) => pathParameter(name, "uuid")),
      idempotencyParameter,
    ],
    requestBody: body(createSchema),
    example: { body: { slug: "finance", name: "Finance" } },
    responses: standardResponses(
      {},
      {
        201: {
          description: "Success",
          headers: commandResponseHeaders,
          content: json(groupSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  getGroup: {
    method: "get",
    path: "/organizations/:organizationId/groups/:groupId",
    operationId: "getGroup",
    summary: "Get an organisation group",
    description:
      "Return an organisation group without changing state. Prefer listGroups to discover its id; validation_failed rejects malformed ids and not_found means the target is unavailable.",
    tag: "Groups",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId", "groupId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "Success",
          headers: revisionResponseHeaders,
          content: json(groupSchema),
        },
        ...problemResponses(400, 404),
      },
    ),
  },
  updateGroup: {
    method: "patch",
    path: "/organizations/:organizationId/groups/:groupId",
    operationId: "updateGroup",
    summary: "Update an organisation group",
    description:
      "Requires Idempotency-Key and the If-Match ETag from getGroup. Missing preconditions return 428 and stale or wrong-instance state returns 412. Committed replay precedes the old revision check. Noops preserve the revision. Identical authorised retries recover the original result for seven days without repeating effects; live changed-input reuse conflicts and expired recovery never executes again. Update an organisation group and return the updated record, recording the change in the audit log. Prefer getGroup to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: { unlessOnly: ["name"] },
    parameters: [
      ...["organizationId", "groupId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
      revisionParameter,
    ],
    requestBody: body(patchSchema),
    example: { body: { name: "Finance team" } },
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          content: json(groupSchema),
        },
        ...problemResponses(400, 404, 409, 410, 412, 428, 503),
      },
    ),
  },
  disableGroup: {
    method: "post",
    path: "/organizations/:organizationId/groups/:groupId/disable",
    operationId: "disableGroup",
    summary: "Disable an organisation group",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects; live changed-input reuse conflicts and expired recovery never executes again. Disable an organisation group and return the updated record. Prefer enableGroup for the opposite transition; not_found means the target is missing and already disabled state returns a noop. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "groupId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
    ],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: commandResponseHeaders,
          content: json(groupSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  enableGroup: {
    method: "post",
    path: "/organizations/:organizationId/groups/:groupId/enable",
    operationId: "enableGroup",
    summary: "Enable an organisation group",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects; live changed-input reuse conflicts and expired recovery never executes again. Enable an organisation group and return the updated record. Prefer disableGroup for the opposite transition; not_found means the target is missing and already active state returns a noop.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "groupId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
    ],
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: commandResponseHeaders,
          content: json(groupSchema),
        },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  eraseGroup: {
    method: "delete",
    path: "/organizations/:organizationId/groups/:groupId",
    operationId: "eraseGroup",
    summary: "Erase an organisation group",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects; live changed-input reuse conflicts and expired recovery never executes again. Soft-delete the group and return no content; related group assignments and entitlements also receive terminal deletedAt markers. The version-3 group.erased audit records actual soft-deleted policy rows and retains affected-user UUID history. This records removed assignments, not a claim that every affected user lost all effective access. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableGroup for reversible offboarding. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input. Product deletion retains rows with terminal deletedAt markers; identifying data can remain. Ordinary reads and authority exclude deleted rows. Enabling cannot restore them. Physical cleanup and its retention period are deferred.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "erase",
    freshAuthentication: true,
    parameters: [
      ...[
        ...["organizationId", "groupId"].map((name) =>
          pathParameter(name, "uuid"),
        ),
        confirmQuery(eraseSchema.shape.confirm),
      ],
      idempotencyParameter,
    ],
    example: { query: { confirm: "00000000-0000-4000-8000-000000000001" } },
    responses: standardResponses(
      {},
      {
        204: { description: "Success", headers: commandResponseHeaders },
        ...problemResponses(400, 404, 409, 410, 503),
      },
    ),
  },
  listGroupMembers: {
    method: "get",
    path: "/organizations/:organizationId/groups/:groupId/members",
    operationId: "listGroupMembers",
    summary: "List group members",
    description:
      "Return a cursor page of group members, without changing state. Prefer getMemberAccess for one target and use limit and cursor to continue through results; validation_failed rejects invalid filters or cursors and not_found means the organisation or parent is unavailable.",
    tag: "Groups",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId", "groupId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(page(groupMemberSchema)) },
        ...problemResponses(400, 404),
      },
    ),
  },
  getGroupMember: {
    method: "get",
    path: "/organizations/:organizationId/groups/:groupId/members/:memberId",
    operationId: "getGroupMember",
    summary: "Read a group assignment",
    description:
      "Return the stored assignment and its strong ETag for conditional replacement. The response excludes time-derived effective access and global user profile fields. not_found means the assignment is absent in this organisation. Use If-None-Match: * when creating an absent assignment.",
    tag: "Groups",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    parameters: ["organizationId", "groupId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: {
          description: "Stored assignment",
          headers: revisionResponseHeaders,
          content: json(membershipSchema),
        },
        ...problemResponses(400, 404),
      },
    ),
  },
  putGroupMember: {
    method: "put",
    path: "/organizations/:organizationId/groups/:groupId/members/:memberId",
    operationId: "putGroupMember",
    summary: "Add or update a group member",
    description:
      "Requires Idempotency-Key and exactly one precondition: If-None-Match: * for creation, or the strong If-Match ETag from getGroupMember for replacement. Missing preconditions return 428; conflicting/malformed headers return 400; stale or recreated state returns 412. Committed replay precedes the precondition check. Identical authorised retries recover the original result for seven days without repeating effects; live changed-input reuse conflicts and expired recovery never executes again. Create or update a manual group membership validity window and return the membership, with 201 for creation and 200 for an update. Prefer removeGroupMember to end membership; validation_failed rejects malformed input, not_found means a parent is missing, and group_directory_managed prevents manual changes to directory groups. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "groupId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      idempotencyParameter,
      {
        ...revisionParameter,
        required: false,
        description:
          "For replacement, supply the assignment ETag. Exactly one precondition is required.",
      },
      {
        in: "header",
        name: "If-None-Match",
        required: false,
        schema: { type: "string", enum: ["*"] },
        description:
          "For creation, assert assignment absence. Mutually exclusive with If-Match.",
      },
    ],
    requestBody: body(windowSchema),
    example: { body: {} },
    responses: standardResponses(
      {},
      {
        200: {
          description: "Success",
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          content: json(membershipSchema),
        },
        201: {
          description: "Membership created",
          headers: { ...commandResponseHeaders, ...revisionResponseHeaders },
          content: json(membershipSchema),
        },
        ...problemResponses(400, 404, 409, 410, 412, 428, 503),
      },
    ),
  },
  removeGroupMember: {
    method: "delete",
    path: "/organizations/:organizationId/groups/:groupId/members/:memberId",
    operationId: "removeGroupMember",
    summary: "Remove a group member",
    description:
      "Requires Idempotency-Key. Identical authorised retries recover the original result for seven days without repeating effects; live changed-input reuse conflicts and expired recovery never executes again. Remove a manual group membership and return no content, removing access inherited through that membership. Prefer putGroupMember to change its validity window; not_found means a parent or membership is missing and group_directory_managed prevents manual changes to directory groups. Removing the last effective platform writer raises last_platform_administrator; establish a replacement and retry the same key/input.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    freshAuthentication: true,
    parameters: [
      ...["organizationId", "groupId", "memberId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
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
    routes.listGroups,
    validate("param", orgParams),
    validate("query", querySchema),
    async (context) => {
      return context.json(
        await tenantRead(context, "directory", (tenant) =>
          service.listGroups(tenant, querySchema.parse(context.req.query())),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.createGroup,
    validate("param", orgParams),
    validate("json", createSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const input = createSchema.parse(await context.req.json());
      return platformCommand(
        context,
        "createGroup",
        operationJson({ organizationId, input }),
        201,
        async (platform) => {
          const row = await service.createGroup(
            platform,
            organizationId,
            input,
          );
          return { body: row, resultReference: { type: "group", id: row.id } };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.getGroup,
    validate("param", groupParams),
    async (context) => {
      const result = await tenantRead(context, "directory", (tenant) =>
        service.getGroup(tenant, context.req.param("groupId")!),
      );
      context.header("ETag", revisionTag(result));
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.updateGroup,
    validate("param", groupParams),
    validate("json", patchSchema),
    async (context) => {
      const expected = requireRevision(context.req.header("If-Match"));
      const organizationId = context.req.param("organizationId")!;
      const groupId = context.req.param("groupId")!;
      const patch = patchSchema.parse(await context.req.json());
      return platformCommand(
        context,
        "updateGroup",
        operationJson({ organizationId, groupId, expected, patch }),
        200,
        async (platform) => {
          const result = await service.updateGroup(
            platform,
            organizationId,
            groupId,
            patch,
            expected,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "group", id: groupId },
          };
        },
        {
          retention: "ordinary",
          etag: (body) =>
            revisionTag(
              groupSchema.pick({ id: true, revision: true }).parse(body),
            ),
        },
      );
    },
  );
  registerRoute(
    app,
    routes.disableGroup,
    validate("param", groupParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const groupId = context.req.param("groupId")!;
      return platformCommand(
        context,
        "disableGroup",
        operationJson({ organizationId, groupId }),
        200,
        async (platform) => {
          const result = await service.disableGroup(
            platform,
            organizationId,
            groupId,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "group", id: groupId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.enableGroup,
    validate("param", groupParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const groupId = context.req.param("groupId")!;
      return platformCommand(
        context,
        "enableGroup",
        operationJson({ organizationId, groupId }),
        200,
        async (platform) => {
          const result = await service.enableGroup(
            platform,
            organizationId,
            groupId,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            resultReference: { type: "group", id: groupId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.eraseGroup,
    validate("param", groupParams),
    validate("query", eraseSchema),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const groupId = context.req.param("groupId")!;
      const confirm = eraseSchema.parse(context.req.query()).confirm;
      return platformCommand(
        context,
        "eraseGroup",
        operationJson({ organizationId, groupId, confirm }),
        204,
        async (platform) => {
          await service.eraseGroup(platform, organizationId, groupId, confirm);
          return {
            body: null,
            resultReference: { type: "group", id: groupId },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
  registerRoute(
    app,
    routes.listGroupMembers,
    validate("param", groupParams),
    validate("query", pageQuerySchema),
    async (context) => {
      return context.json(
        await tenantRead(context, "directory", (tenant) =>
          service.listGroupMembers(
            tenant,
            context.req.param("groupId")!,
            pageQuerySchema.parse(context.req.query()),
          ),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.getGroupMember,
    validate("param", memberParams),
    async (context) => {
      const result = await tenantRead(context, "directory", (tenant) =>
        service.getGroupMember(
          tenant,
          context.req.param("groupId")!,
          context.req.param("memberId")!,
        ),
      );
      context.header("ETag", revisionTag(result));
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.putGroupMember,
    validate("param", memberParams),
    validate("json", windowSchema),
    async (context) => {
      const expected = requirePutRevision(
        context.req.header("If-Match"),
        context.req.header("If-None-Match"),
      );
      const organizationId = context.req.param("organizationId")!;
      const groupId = context.req.param("groupId")!;
      const memberId = context.req.param("memberId")!;
      const window = windowDates(windowSchema.parse(await context.req.json()));
      return platformCommand(
        context,
        "putGroupMember",
        operationJson({ organizationId, groupId, memberId, expected, window }),
        200,
        async (platform) => {
          const result = await service.putMember(
            platform,
            organizationId,
            groupId,
            memberId,
            window,
            expected,
          );
          return {
            body: result.row,
            outcome: result.changed ? "applied" : "noop",
            statusCode: result.created ? 201 : 200,
            resultReference: {
              type: "group_member",
              id: `${groupId}:${memberId}`,
            },
          };
        },
        {
          retention: "ordinary",
          etag: (body) =>
            revisionTag(
              membershipSchema.pick({ id: true, revision: true }).parse(body),
            ),
        },
      );
    },
  );
  registerRoute(
    app,
    routes.removeGroupMember,
    validate("param", memberParams),
    async (context) => {
      const organizationId = context.req.param("organizationId")!;
      const groupId = context.req.param("groupId")!;
      const memberId = context.req.param("memberId")!;
      return platformCommand(
        context,
        "removeGroupMember",
        operationJson({ organizationId, groupId, memberId }),
        204,
        async (platform) => {
          await service.removeMember(
            platform,
            organizationId,
            groupId,
            memberId,
          );
          return {
            body: null,
            resultReference: {
              type: "group_member",
              id: `${groupId}:${memberId}`,
            },
          };
        },
        { retention: "ordinary" },
      );
    },
  );
}
