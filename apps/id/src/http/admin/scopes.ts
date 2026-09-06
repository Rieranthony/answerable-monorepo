export const adminScopes = [
  "platform:read",
  "platform:users",
  "platform:write",
  "org:read",
  "org:users",
  "org:write",
] as const;

export type AdminScope = (typeof adminScopes)[number];

export function isAdminScope(scope: string): scope is AdminScope {
  return (adminScopes as readonly string[]).includes(scope);
}
