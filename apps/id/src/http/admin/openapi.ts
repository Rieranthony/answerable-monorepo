import type { MiddlewareHandler } from "hono";
import { describeRoute, type DescribeRouteOptions } from "hono-openapi";
import type { AppEnvironment } from "../context.ts";
import { problemResponses } from "../problem.ts";
import { tierOf, type AdminRoute } from "./route-table.ts";

export const adminSecuritySchemes = {
  cookieAuth: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
  },
  bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
} as const;
export const adminTags = [
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
  const described = describeRoute({
    operationId: route.operationId,
    summary: route.summary,
    tags: [route.tag],
    responses: standardResponses(route, route.responses),
    parameters: route.parameters,
    requestBody: route.requestBody,
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    "x-tier": tierOf(route),
  } as DescribeRouteOptions);
  const middleware: MiddlewareHandler<AppEnvironment> = async (
    context,
    next,
  ) => {
    context.set("operationId", route.operationId);
    await described(context, next);
  };
  return Object.assign(middleware, described);
}
