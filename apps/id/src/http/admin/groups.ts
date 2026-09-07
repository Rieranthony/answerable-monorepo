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
import { actorFromContext } from "../../services/actor.ts";
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
  organizationId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  externalId: z.string().nullable(),
  status: z.enum(lifecycleStatuses),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const membershipSchema = z.object({
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
      "Create an organisation group and return the created record, recording the change in the audit log. Prefer getGroup to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId"].map((name) => pathParameter(name, "uuid")),
    requestBody: body(createSchema),
    example: { body: { slug: "finance", name: "Finance" } },
    responses: standardResponses(
      {},
      {
        201: { description: "Success", content: json(groupSchema) },
        ...problemResponses(400, 404, 409),
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
    parameters: ["organizationId", "groupId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    orgScope: "org:read",
    responses: standardResponses(
      { orgScope: "org:read" },
      {
        200: { description: "Success", content: json(groupSchema) },
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
      "Update an organisation group and return the updated record, recording the change in the audit log. Prefer getGroup to inspect existing state; validation_failed rejects malformed input, not_found identifies missing parents or targets, and conflict or reference_violation identifies conflicting records.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "groupId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    requestBody: body(patchSchema),
    example: { body: { name: "Finance team" } },
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(groupSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  disableGroup: {
    method: "post",
    path: "/organizations/:organizationId/groups/:groupId/disable",
    operationId: "disableGroup",
    summary: "Disable an organisation group",
    description:
      "Disable an organisation group and return the updated record. Prefer enableGroup for the opposite transition; not_found means the target is missing and group_already_disabled means no transition is needed.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "groupId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(groupSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  enableGroup: {
    method: "post",
    path: "/organizations/:organizationId/groups/:groupId/enable",
    operationId: "enableGroup",
    summary: "Enable an organisation group",
    description:
      "Enable an organisation group and return the updated record. Prefer disableGroup for the opposite transition; not_found means the target is missing and group_already_active means no transition is needed.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "groupId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(groupSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  eraseGroup: {
    method: "delete",
    path: "/organizations/:organizationId/groups/:groupId",
    operationId: "eraseGroup",
    summary: "Erase an organisation group",
    description:
      "Permanently erase the group and return no content; related group memberships and entitlements are also deleted. The confirm query parameter must equal the target id. A missing target raises not_found before a mismatched confirmation raises confirmation_mismatch; prefer disableGroup for reversible offboarding.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "erase",
    parameters: [
      ...["organizationId", "groupId"].map((name) =>
        pathParameter(name, "uuid"),
      ),
      confirmQuery(eraseSchema.shape.confirm),
    ],
    example: { query: { confirm: "00000000-0000-4000-8000-000000000001" } },
    responses: standardResponses(
      {},
      { 204: { description: "Success" }, ...problemResponses(400, 404, 409) },
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
  putGroupMember: {
    method: "put",
    path: "/organizations/:organizationId/groups/:groupId/members/:memberId",
    operationId: "putGroupMember",
    summary: "Add or update a group member",
    description:
      "Create or update a manual group membership validity window and return the membership, with 201 for creation and 200 for an update. Prefer removeGroupMember to end membership; validation_failed rejects malformed input, not_found means a parent is missing, and group_directory_managed prevents manual changes to directory groups.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "groupId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    requestBody: body(windowSchema),
    example: { body: {} },
    responses: standardResponses(
      {},
      {
        200: { description: "Success", content: json(membershipSchema) },
        201: {
          description: "Membership created",
          content: json(membershipSchema),
        },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  removeGroupMember: {
    method: "delete",
    path: "/organizations/:organizationId/groups/:groupId/members/:memberId",
    operationId: "removeGroupMember",
    summary: "Remove a group member",
    description:
      "Remove a manual group membership and return no content, removing access inherited through that membership. Prefer putGroupMember to change its validity window; not_found means a parent or membership is missing and group_directory_managed prevents manual changes to directory groups.",
    tag: "Groups",
    platformScope: "platform:write",
    kind: "write",
    parameters: ["organizationId", "groupId", "memberId"].map((name) =>
      pathParameter(name, "uuid"),
    ),
    responses: standardResponses(
      {},
      { 204: { description: "Success" }, ...problemResponses(400, 404, 409) },
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
        await service.listGroups(
          context.get("db"),
          context.req.param("organizationId")!,
          querySchema.parse(context.req.query()),
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
      return context.json(
        await service.createGroup(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          createSchema.parse(await context.req.json()),
        ),
        201,
      );
    },
  );
  registerRoute(
    app,
    routes.getGroup,
    validate("param", groupParams),
    async (context) => {
      return context.json(
        await service.getGroup(
          context.get("db"),
          context.req.param("organizationId")!,
          context.req.param("groupId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.updateGroup,
    validate("param", groupParams),
    validate("json", patchSchema),
    async (context) => {
      return context.json(
        await service.updateGroup(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("groupId")!,
          patchSchema.parse(await context.req.json()),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.disableGroup,
    validate("param", groupParams),
    async (context) => {
      return context.json(
        await service.disableGroup(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("groupId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.enableGroup,
    validate("param", groupParams),
    async (context) => {
      return context.json(
        await service.enableGroup(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("groupId")!,
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.eraseGroup,
    validate("param", groupParams),
    validate("query", eraseSchema),
    async (context) => {
      await service.eraseGroup(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        context.req.param("groupId")!,
        eraseSchema.parse(context.req.query()).confirm,
      );
      return context.body(null, 204);
    },
  );
  registerRoute(
    app,
    routes.listGroupMembers,
    validate("param", groupParams),
    validate("query", pageQuerySchema),
    async (context) => {
      return context.json(
        await service.listGroupMembers(
          context.get("db"),
          context.req.param("organizationId")!,
          context.req.param("groupId")!,
          pageQuerySchema.parse(context.req.query()),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.putGroupMember,
    validate("param", memberParams),
    validate("json", windowSchema),
    async (context) => {
      const result = await service.putMember(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        context.req.param("groupId")!,
        context.req.param("memberId")!,
        windowDates(windowSchema.parse(await context.req.json())),
      );
      return context.json(result.row, result.created ? 201 : 200);
    },
  );
  registerRoute(
    app,
    routes.removeGroupMember,
    validate("param", memberParams),
    async (context) => {
      await service.removeMember(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        context.req.param("groupId")!,
        context.req.param("memberId")!,
      );
      return context.body(null, 204);
    },
  );
}
