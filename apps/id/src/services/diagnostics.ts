import type { Database } from "../db/client.ts";
import { findOrganizationByDomain } from "../db/queries/organization-domains.ts";
import { findOrganization } from "../db/queries/organizations.ts";
import { findSsoProviderByOrganization } from "../db/queries/sso-providers.ts";
import { findUserByEmail } from "../db/queries/users.ts";
import { ProblemError } from "../http/problem.ts";
import { classifyIssuer } from "./federation.ts";

export const signInVerdictCodes = [
  "provider_not_found",
  "organization_disabled",
  "domain_not_allowed",
  "new_user_would_be_created",
  "user_disabled",
  "identity_conflict",
  "would_sign_in",
] as const;
export const tokenOnlyCodes = [
  "directory_mismatch",
  "guest_account",
  "personal_account",
  "hosted_domain_mismatch",
  "email_unverified",
] as const;

/** A read-only email diagnosis, not a prediction of token claims or subject. */
export async function diagnoseSignIn(
  db: Database,
  organizationId: string,
  email: string,
) {
  email = email.toLowerCase();
  const organization = await findOrganization(db, organizationId);
  if (!organization)
    throw new ProblemError(404, "not_found", "Organisation not found");
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const [routing, provider, user] = await Promise.all([
    findOrganizationByDomain(db, domain),
    findSsoProviderByOrganization(db, organizationId),
    findUserByEmail(db, email),
  ]);
  const matchesThisOrganization = routing?.id === organizationId;
  const accounts = (user?.accounts ?? []).map((account) => ({
    issuer: account.issuer,
    matchesProvider: provider !== null && account.issuer === provider.issuer,
    directoryId: account.directoryId,
  }));
  const membership = user?.memberships.find(
    (member) => member.organizationId === organizationId,
  );
  const checks: [(typeof signInVerdictCodes)[number], boolean][] = [
    ["provider_not_found", provider === null],
    ["organization_disabled", organization.status !== "active"],
    ["domain_not_allowed", !matchesThisOrganization],
    ["new_user_would_be_created", user === null],
    ["user_disabled", user?.status === "disabled"],
    [
      "identity_conflict",
      accounts.length > 0 &&
        accounts.every((account) => !account.matchesProvider),
    ],
    ["would_sign_in", true],
  ];
  const checked: string[] = [];
  let code: (typeof signInVerdictCodes)[number] = "would_sign_in";
  for (const [candidate, applies] of checks) {
    checked.push(candidate);
    if (applies) {
      code = candidate;
      break;
    }
  }
  return {
    email,
    routing: {
      domain,
      routesTo: routing
        ? { organizationId: routing.id, slug: routing.slug }
        : null,
      matchesThisOrganization,
    },
    organization: {
      id: organization.id,
      slug: organization.slug,
      status: organization.status,
    },
    provider: {
      configured: provider !== null,
      kind: provider ? classifyIssuer(provider.issuer).kind : null,
      issuer: provider ? provider.issuer : null,
    },
    user: user
      ? {
          id: user.id,
          status: user.status,
          retiredEmail: user.retiredEmail !== null,
        }
      : null,
    accounts,
    membership: membership
      ? {
          memberId: membership.memberId,
          effective: membership.effective,
          validFrom: membership.validFrom,
          validUntil: membership.validUntil,
        }
      : null,
    verdict: { code, checked, requiresToken: [...tokenOnlyCodes] },
  };
}
