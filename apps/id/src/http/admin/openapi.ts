import { describeRoute, type DescribeRouteOptions } from "hono-openapi";
import { problemResponses } from "../problem.ts";
import { requestBoundaryResponses } from "../request-limits.ts";
import { tierOf, type AdminRoute } from "./route-table.ts";

export const adminSecuritySchemes = {
  cookieAuth: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
  },
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "A JWT for the admin API resource, or the root admin secret while it is enabled.",
  },
} as const;
export const adminTags = [
  { name: "Diagnostics", description: "Read-only sign-in and SSO diagnostics" },
  { name: "Audit", description: "Audit event reads" },
  { name: "Operations", description: "Committed operation reads" },
  { name: "Users", description: "User administration" },
  { name: "Sessions", description: "Session administration" },
  {
    name: "Entitlements",
    description: "Organisation entitlement administration",
  },
  { name: "Access", description: "Effective access reviews" },
  { name: "Groups", description: "Organisation group administration" },
  { name: "Members", description: "Organisation member administration" },
  { name: "Resources", description: "OAuth resource administration" },
  { name: "Clients", description: "OAuth client administration" },
  { name: "Domains", description: "Organisation domain administration" },
  {
    name: "SSO provider",
    description: "Organisation SSO provider administration",
  },
  { name: "Organizations", description: "Organisation administration" },
  {
    name: "Capabilities",
    description: "Organisation capability administration",
  },
  { name: "Me", description: "Current principal and effective grants" },
];

function standardResponses(
  route: Pick<AdminRoute, "orgScope">,
  success: DescribeRouteOptions["responses"],
) {
  return {
    ...success,
    ...requestBoundaryResponses,
    ...problemResponses(401, 403, 503),
    ...(route.orgScope ? problemResponses(404) : {}),
  };
}

const idempotency =
  "Requires Idempotency-Key. Identical authorised retries return the receipt without repeating the mutation or its audit event; changed input returns idempotency_key_reused.";

const idempotencyParameter = {
  in: "header" as const,
  name: "Idempotency-Key",
  required: true,
  schema: { type: "string" as const, minLength: 1, maxLength: 256 },
  description:
    "Stable key for this logical command. Reuse it with identical input after a lost response.",
};

const commandResponseHeaders = {
  "Operation-Id": {
    description: "Immutable logical operation ID",
    schema: { type: "string" as const, format: "uuid" },
  },
  "Idempotency-Replayed": {
    description: "Whether this response was recovered from the journal",
    schema: { type: "string" as const, enum: ["true", "false"] },
  },
};

/** Every command's journal contract, which no route restates. */
function withCommandContract(route: AdminRoute): AdminRoute {
  if (route.kind === "read") return route;
  return {
    ...route,
    description: `${idempotency} ${route.description}`,
    parameters: [...(route.parameters ?? []), idempotencyParameter],
    responses: {
      ...problemResponses(400, 409, 503),
      ...Object.fromEntries(
        Object.entries(route.responses ?? {}).map(([status, response]) => [
          status,
          /^2\d\d$/.test(status) && !("$ref" in response)
            ? {
                ...response,
                headers: { ...commandResponseHeaders, ...response.headers },
              }
            : response,
        ]),
      ),
    },
  };
}

export function adminRoute(adminRoute: AdminRoute) {
  const route = withCommandContract(adminRoute);
  return describeRoute({
    operationId: route.operationId,
    summary: route.summary,
    description: route.description,
    tags: [route.tag],
    responses: standardResponses(route, route.responses),
    parameters: route.parameters?.map((parameter) => {
      if (
        "in" in parameter &&
        parameter.in === "query" &&
        route.example?.query?.[parameter.name] !== undefined
      )
        return { ...parameter, example: route.example.query[parameter.name] };
      return parameter;
    }),
    requestBody:
      route.requestBody &&
      "content" in route.requestBody &&
      route.example?.body !== undefined
        ? {
            ...route.requestBody,
            content: {
              ...route.requestBody.content,
              "application/json": {
                ...route.requestBody.content["application/json"],
                example: route.example.body,
              },
            },
          }
        : route.requestBody,
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    "x-tier": tierOf(route),
    "x-kind": route.kind,
    "x-fresh-authentication": route.freshAuthentication ?? false,
    "x-scopes": route.open
      ? {}
      : {
          platform: route.platformScope,
          ...(route.orgScope ? { org: route.orgScope } : {}),
        },
  } as DescribeRouteOptions);
}
