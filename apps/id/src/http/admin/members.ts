import * as service from "../../services/members.ts";
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
import { userStatuses } from "../../db/schema/vocabulary.ts";
const windowSchema = z.object({
  validFrom: z.iso.datetime().nullable().optional(),
  validUntil: z.iso.datetime().nullable().optional(),
});
function windowDates(input: z.output<typeof windowSchema>) {
  return {
    validFrom:
      input.validFrom === undefined
        ? undefined
        : input.validFrom === null
          ? null
          : new Date(input.validFrom),
    validUntil:
      input.validUntil === undefined
        ? undefined
        : input.validUntil === null
          ? null
          : new Date(input.validUntil),
  };
}
const json = (schema: z.ZodType) => ({
  "application/json": { schema: resolver(schema) },
});
const body = (schema: z.ZodType) =>
  ({
    required: true,
    content: { "application/json": { schema: z.toJSONSchema(schema) } },
  }) as AdminRoute["requestBody"];
const parameters = (names: string[]) =>
  names.map((name) => ({
    in: "path" as const,
    name,
    required: true,
    schema: { type: "string" as const, format: "uuid" },
  }));
const page = (schema: z.ZodType) =>
  z.object({ items: z.array(schema), nextCursor: z.uuid().nullable() });
const orgParams = z.object({ organizationId: z.uuid() });
export const memberSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  userId: z.uuid(),
  email: z.string(),
  name: z.string(),
  status: z.enum(userStatuses),
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
  q: z.string().trim().min(1).max(100).optional(),
  effective: z.enum(["true", "false"]).optional(),
});
const patchSchema = windowSchema.refine(
  (input) => Object.keys(input).length > 0,
  "At least one field is required",
);
const memberParams = orgParams.extend({ memberId: z.uuid() });
export const routes = {
  listMembers: {
    method: "get",
    path: "/organizations/:organizationId/members",
    operationId: "listMembers",
    summary: "List organisation members",
    tag: "Members",
    platformScope: "platform:read",
    kind: "read",
    parameters: parameters(["organizationId"]),
    orgScope: "org:read",
    paginated: true,
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
    tag: "Members",
    platformScope: "platform:read",
    kind: "read",
    parameters: parameters(["organizationId", "memberId"]),
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
    tag: "Members",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["organizationId", "memberId"]),
    orgScope: "org:users",
    requestBody: body(patchSchema),
    example: { body: { validUntil: null } },
    responses: standardResponses(
      { orgScope: "org:users" },
      {
        200: { description: "Success", content: json(detailSchema) },
        ...problemResponses(400, 404, 409),
      },
    ),
  },
  removeMember: {
    method: "delete",
    path: "/organizations/:organizationId/members/:memberId",
    operationId: "removeMember",
    summary: "Remove an organisation member",
    tag: "Members",
    platformScope: "platform:users",
    kind: "write",
    parameters: parameters(["organizationId", "memberId"]),
    orgScope: "org:users",
    responses: standardResponses(
      { orgScope: "org:users" },
      { 204: { description: "Success" }, ...problemResponses(400, 404, 409) },
    ),
  },
} satisfies Record<string, AdminRoute>;
export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.listMembers,
    validate("param", orgParams),
    validate("query", querySchema),
    async (context) => {
      const query = querySchema.parse(context.req.query());
      return context.json(
        await service.listMembers(
          context.get("db"),
          context.req.param("organizationId")!,
          {
            ...query,
            effective:
              query.effective === undefined
                ? undefined
                : query.effective === "true",
          },
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
        await service.getMember(
          context.get("db"),
          context.req.param("organizationId")!,
          context.req.param("memberId")!,
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
      return context.json(
        await service.updateWindow(
          context.get("db"),
          actorFromContext(context),
          context.req.param("organizationId")!,
          context.req.param("memberId")!,
          windowDates(patchSchema.parse(await context.req.json())),
        ),
        200,
      );
    },
  );
  registerRoute(
    app,
    routes.removeMember,
    validate("param", memberParams),
    async (context) => {
      await service.remove(
        context.get("db"),
        actorFromContext(context),
        context.req.param("organizationId")!,
        context.req.param("memberId")!,
      );
      return context.body(null, 204);
    },
  );
}
