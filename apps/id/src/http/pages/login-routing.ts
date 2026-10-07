import { slugPattern } from "../../db/schema/columns.ts";

export type LoginRoute =
  { mode: "auto"; organizationSlug: string } | { mode: "form"; email?: string };

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function decideLoginRoute(params: URLSearchParams): LoginRoute {
  const organizationSlug = params.get("organization");
  const loginHint = params.get("login_hint");

  if (
    organizationSlug !== null &&
    slugPattern.test(organizationSlug) &&
    !params.has("login_hint")
  ) {
    return { mode: "auto", organizationSlug };
  }

  if (loginHint !== null && emailPattern.test(loginHint)) {
    return { mode: "form", email: loginHint };
  }

  return { mode: "form" };
}

export function pendingOAuthQuery(params: URLSearchParams): string | null {
  if (!params.has("client_id") || !params.has("sig")) return null;
  return params.toString();
}
