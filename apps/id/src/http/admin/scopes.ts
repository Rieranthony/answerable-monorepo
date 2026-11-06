export const adminScopes = [
  "platform:read",
  "platform:users",
  "platform:write",
  "org:read",
  "org:users",
  "org:members",
] as const;

export type AdminScope = (typeof adminScopes)[number];
export type PlatformScope = Extract<AdminScope, `platform:${string}`>;

/** Scopes match exactly, with one exception: `org:read` also holds `org:members`, the narrower read of members and group names. */
export function holdsScope(held: readonly string[], required: AdminScope) {
  return (
    held.includes(required) ||
    (required === "org:members" && held.includes("org:read"))
  );
}

export function isAdminScope(scope: string): scope is AdminScope {
  return (adminScopes as readonly string[]).includes(scope);
}
