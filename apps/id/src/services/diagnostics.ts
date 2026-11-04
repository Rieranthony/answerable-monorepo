import { listMembers } from "../db/queries/members.ts";
import { type TenantReadContext } from "./tenant-context.ts";
import { organizationAcceptsDomain } from "../db/queries/organization-domains.ts";
import { readOrganizationStatus } from "../db/queries/organizations.ts";
import { withDatabaseScope } from "../db/isolation.ts";
import {
  readDirectoryConnection,
  readMagicLinkSetting,
  readLastMagicLinkRequest,
} from "../db/queries/magic-link-requests.ts";
import { readSsoIssuer } from "../db/queries/sso-providers.ts";
import { classifyIssuer } from "./federation.ts";
import {
  admitMagicLink,
  parseMagicLinkAddress,
} from "./magic-link-admission.ts";

export const signInVerdictCodes = [
  "provider_not_found",
  "organization_disabled",
  "domain_not_allowed",
  "user_disabled",
  "membership_revoked",
  "magic_link_not_admitted",
  "magic_link_suppressed",
  "authentication_required",
] as const;
export const tokenOnlyCodes = [
  "directory_mismatch",
  "guest_account",
  "personal_account",
  "hosted_domain_mismatch",
  "email_unverified",
  "identity_conflict",
  "email_conflict",
] as const;

/** Postmark's code for an address it will not send to, after a hard bounce or a complaint. */
const postmarkSuppressed = 406;

/** Local blockers only: an email cannot establish the authenticated identity. */
export async function diagnoseSignIn(
  context: TenantReadContext<"memberAccess">,
  email: string,
) {
  email = email.toLowerCase();
  // The context holds a shared lock on this existing organisation.
  const organization = (await readOrganizationStatus(context))!;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const [
    matchesThisOrganization,
    provider,
    memberRows,
    linksOn,
    lastRequest,
    directoryConnection,
  ] = await Promise.all([
    organizationAcceptsDomain(context, domain),
    readSsoIssuer(context),
    listMembers(context, { email, limit: 1 }),
    readMagicLinkSetting(context),
    readLastMagicLinkRequest(context, email),
    readDirectoryConnection(context, email),
  ]);
  const membership = memberRows.items[0];
  const suppressed = lastRequest?.postmarkErrorCode === postmarkSuppressed;
  // The one admission check, whose rules this must not restate: its switch, its mode and the
  // person. Asked only of this firm's own domains, since an answer about another firm's address
  // would say who is a member there, and it says only yes or no.
  const address = parseMagicLinkAddress(email);
  const admitted =
    matchesThisOrganization &&
    address !== null &&
    (
      await withDatabaseScope(context.tx, { kind: "protocol" }, (tx) =>
        admitMagicLink(tx, address),
      )
    ).outcome === "admit";
  const checks: [(typeof signInVerdictCodes)[number], boolean][] = [
    ["provider_not_found", provider === null && !linksOn],
    ["organization_disabled", organization.status !== "active"],
    ["domain_not_allowed", !matchesThisOrganization],
    ["user_disabled", membership?.status === "disabled"],
    ["membership_revoked", membership?.membershipStatus === "revoked"],
    // Both only a block where a link is the way in; a directory sign-in reads neither.
    ["magic_link_not_admitted", provider === null && !admitted],
    ["magic_link_suppressed", provider === null && suppressed],
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
    magicLink: {
      enabled: linksOn,
      admitted,
      suppressed,
      lastRequest,
      directoryConnection,
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
