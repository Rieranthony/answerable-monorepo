/** Explicit requests must fit every ceiling; omitted scopes use their intersection. */
export function grantScopes(
  requested: readonly string[] | undefined,
  ceilings: readonly (readonly string[])[],
): string[] | null {
  const allowed = (ceilings[0] ?? []).filter((scope) =>
    ceilings.every((ceiling) => ceiling.includes(scope)),
  );
  const selected = [...new Set(requested ?? allowed)].sort();
  return selected.length && selected.every((scope) => allowed.includes(scope))
    ? selected
    : null;
}

/** Keep only requested scopes present in every ceiling; an empty intersection is refused. */
export function narrowScopes(
  requested: readonly string[],
  ceilings: readonly (readonly string[])[],
): string[] | null {
  const selected = [...new Set(requested)]
    .filter(
      (scope) =>
        ceilings.length > 0 &&
        ceilings.every((ceiling) => ceiling.includes(scope)),
    )
    .sort();
  return selected.length ? selected : null;
}

export const identityScopes: ReadonlySet<string> = new Set([
  "openid",
  "profile",
  "email",
  "offline_access",
  "address",
  "phone",
]);
