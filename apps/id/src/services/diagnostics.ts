import { listMembers } from "../db/queries/members.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import { organizationAcceptsDomain } from "../db/queries/organization-domains.ts";
import { readOrganizationStatus } from "../db/queries/organizations.ts";
import { readSsoIssuer } from "../db/queries/sso-providers.ts";
import { classifyIssuer } from "./federation.ts";

export const signInVerdictCodes = [
  "provider_not_found",
  "organization_disabled",
  "domain_not_allowed",
  "user_disabled",
  "membership_revoked",
  "authentication_required",
] as const;
export const tokenOnlyCodes = [
  "directory_mismatch",
  "guest_account",
  "personal_account",
  "hosted_domain_mismatch",
  "email_unverified",
  "identity_conflict",
] as const;

/** Local blockers only: an email cannot establish the authenticated identity. */
export async function diagnoseSignIn(
  context: TenantReadContext<"memberAccess">,
  email: string,
) {
  email = email.toLowerCase();
  // The context holds a shared lock on this existing organisation.
  const organization = (await readOrganizationStatus(context))!;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const [matchesThisOrganization, provider, memberRows] = await Promise.all([
    organizationAcceptsDomain(context, domain),
    readSsoIssuer(context),
    listMembers(context, { email, limit: 1 }),
  ]);
  const membership = memberRows[0];
  const checks: [(typeof signInVerdictCodes)[number], boolean][] = [
    ["provider_not_found", provider === null],
    ["organization_disabled", organization.status !== "active"],
    ["domain_not_allowed", !matchesThisOrganization],
    ["user_disabled", membership?.status === "disabled"],
    ["membership_revoked", membership?.membershipStatus === "revoked"],
    ["authentication_required", true],
  ];
  const checked: string[] = [];
  let code: (typeof signInVerdictCodes)[number] = "authentication_required";
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
      routesTo: matchesThisOrganization
        ? { organizationId: organization.id, slug: organization.slug }
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
    user: membership
      ? { id: membership.userId, status: membership.status }
      : null,
    membership: membership
      ? {
          memberId: membership.id,
          effective: membership.effective,
          validFrom: membership.validFrom,
          validUntil: membership.validUntil,
        }
      : null,
    verdict: { code, checked, requiresToken: [...tokenOnlyCodes] },
  };
}
