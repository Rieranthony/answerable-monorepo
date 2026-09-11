import type { Hono } from "hono";
import { z } from "zod";
import {
  getOwnOperationStatus,
  getAuditOperationStatus,
  ownOperationScopes,
} from "../../services/operation-status.ts";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { validate } from "../validation.ts";
import { standardResponses } from "./openapi.ts";
import { registerRoute, type AdminRoute } from "./route-table.ts";
import { json, pathParameter, uuidParam } from "./schemas.ts";

const response = standardResponses(
  {},
  {
    200: {
      description: "Committed operation; result reference only",
      content: json(
        z.object({
          id: z.uuid(),
          name: z.string(),
          outcome: z.enum(["applied", "noop"]),
          statusCode: z.number().int(),
          resultReference: z.object({ type: z.string(), id: z.string() }),
          committedAt: z.iso.datetime(),
          replay: z.enum(["reference", "available", "expired"]),
          replayExpiresAt: z.iso.datetime().nullable(),
        }),
      ),
    },
    ...problemResponses(400, 404),
  },
);
export const routes = {
  getOwnOperation: {
    method: "get",
    path: "/me/operations/:operationId",
    operationId: "getMyOperationStatus",
    summary: "Get my operation status",
    tag: "Operations",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    open: true,
    scopeAlternatives: ownOperationScopes,
    description:
      "Read only a receipt owned by the authenticated actor. Current administrative scope in the receipt's platform or tenant is required: read, write or users. This grants no access to other actors' receipts. Returns only the result reference, never fingerprints, keys or response payloads. Missing and foreign-actor receipts return 404; lost authority returns 403 and stale authentication 401. A missing receipt does not prove that no concurrent command is running.",
    parameters: [pathParameter("operationId", "uuid")],
    responses: response,
  },
  getOperation: {
    method: "get",
    path: "/operations/:operationId",
    operationId: "getOperationStatus",
    summary: "Get an operation status",
    tag: "Operations",
    platformScope: "platform:read",
    kind: "read",
    freshAuthentication: false,
    description:
      "Read a committed operation with platform audit authority. Returns its outcome and result reference without request fingerprints, replay keys or secrets. not_found means no committed operation exists; this does not prove that a concurrent request is not running. Every administrative mutation creates a journal record. Use getMyOperationStatus to inspect only your own receipts without platform audit access.",
    parameters: [pathParameter("operationId", "uuid")],
    responses: response,
  },
  getOrganizationOperation: {
    method: "get",
    path: "/organizations/:organizationId/operations/:operationId",
    operationId: "getOrganizationOperationStatus",
    summary: "Get an organisation operation status",
    tag: "Operations",
    platformScope: "platform:read",
    orgScope: "org:read",
    kind: "read",
    freshAuthentication: false,
    description:
      "Read a committed operation in this organisation. Tenant callers can read only their own operations; platform readers can audit every actor in the organisation. Missing, foreign-actor and foreign-tenant operations all return not_found. Only result references are returned, including after the referenced entity is erased. Tenant-scoped member mutations create records here. Platform-scoped client, resource, domain, organisation, SSO and group commands use the platform operation-status route.",
    parameters: [
      pathParameter("organizationId", "uuid"),
      pathParameter("operationId", "uuid"),
    ],
    responses: response,
  },
} satisfies Record<string, AdminRoute>;

export function register(app: Hono<AppEnvironment>) {
  registerRoute(
    app,
    routes.getOwnOperation,
    validate("param", uuidParam("operationId")),
    async (context) => {
      context.header("Cache-Control", "no-store");
      const result = await getOwnOperationStatus(
        context.get("db"),
        context.req.param("operationId")!,
        {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
        },
      );
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.getOperation,
    validate("param", uuidParam("operationId")),
    async (context) => {
      context.header("Cache-Control", "no-store");
      const result = await getAuditOperationStatus(
        context.get("db"),
        context.req.param("operationId")!,
        {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
        },
      );
      return context.json(result);
    },
  );
  registerRoute(
    app,
    routes.getOrganizationOperation,
    validate(
      "param",
      uuidParam("organizationId").extend(uuidParam("operationId").shape),
    ),
    async (context) => {
      context.header("Cache-Control", "no-store");
      const result = await getAuditOperationStatus(
        context.get("db"),
        context.req.param("operationId")!,
        {
          principal: context.get("principal")!,
          environment: context.get("environment"),
          claims: context.get("bearerClaims"),
        },
        context.req.param("organizationId")!,
      );
      return context.json(result);
    },
  );
}
