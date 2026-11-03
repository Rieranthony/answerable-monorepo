import { slugPattern } from "../../db/schema/columns.ts";

export type LoginRoute =
  { mode: "auto"; organizationSlug: string } | { mode: "form"; email?: string };

/** An address is at most 254 characters, so nothing longer reaches the pattern. */
export const maxLoginAddressLength = 254;

const loginAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether a typed or hinted value has the shape of an address we route on. */
export function isLoginAddress(value: string): boolean {
  return (
    value.length <= maxLoginAddressLength && loginAddressPattern.test(value)
  );
}

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

  if (loginHint !== null && isLoginAddress(loginHint)) {
    return { mode: "form", email: loginHint };
  }

  return { mode: "form" };
}

export function pendingOAuthQuery(params: URLSearchParams): string | null {
  if (!params.has("client_id") || !params.has("sig")) return null;
  return params.toString();
}
