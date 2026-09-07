import { describeRoute, type DescribeRouteOptions } from "hono-openapi";
import { problemResponses } from "../problem.ts";
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
  { name: "Platform", description: "Fleet analysis summaries" },
  { name: "Audit", description: "Audit event reads" },
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
  { name: "Me", description: "Current principal and effective grants" },
];

export function standardResponses(
  route: Pick<AdminRoute, "orgScope">,
  success: DescribeRouteOptions["responses"],
) {
  return {
    ...success,
    ...problemResponses(401, 403),
    ...(route.orgScope ? problemResponses(404) : {}),
  };
}

export function adminRoute(route: AdminRoute) {
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
    "x-scopes": {
      platform: route.platformScope,
      ...(route.orgScope ? { org: route.orgScope } : {}),
    },
  } as DescribeRouteOptions);
}
