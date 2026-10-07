import { parseScope } from "../lib/scopes.ts";

/** Bind native authorisation codes to the approved grant and scope subset. */
export function narrowAuthorizationCode(
  value: string,
  grantId: string,
  granted: readonly string[],
  invalid: () => Error,
): string {
  let stored;
  try {
    stored = JSON.parse(value);
  } catch {
    return value;
  }
  if (stored?.type !== "authorization_code") return value;
  const scopes = parseScope(
    typeof stored.query?.scope === "string" ? stored.query.scope : null,
  );
  if (
    stored.referenceId !== grantId ||
    granted.some((scope) => !scopes.includes(scope))
  )
    throw invalid();
  return JSON.stringify({
    ...stored,
    query: { ...stored.query, scope: granted.join(" ") },
  });
}
