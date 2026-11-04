import type {
  SSOUserResolutionInput,
  SSOUserResolution,
} from "@better-auth/sso";
import type { DBTransactionAdapter } from "better-auth";

import { noteRefusedIdentity } from "../auth/refused-identity.ts";

type ProviderRow = {
  id: string;
  organizationId: string;
  revision: number;
};

type OrganizationRow = {
  id: string;
  status: "active" | "disabled";
  deletedAt?: Date | null;
};

type UserRow = {
  id: string;
  email: string;
  status: "active" | "disabled";
  deletedAt?: Date | null;
};

type AccountRow = {
  deletedAt?: Date | null;
  id: string;
  providerId: string;
  userId: string;
  directoryId?: string | null;
  directoryUserId?: string | null;
  user?: UserRow | null;
};

const entraIssuer =
  /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/;

export function classifyIssuer(issuer: string) {
  const entra = entraIssuer.exec(issuer);
  if (entra) return { kind: "entra" as const, tenantId: entra[1]! };
  if (issuer === "https://accounts.google.com") {
    return { kind: "google" as const };
  }
  return { kind: "oidc" as const };
}

/**
 * What `accounts.directory_id` holds for a verified sign-in at this address: a tenant is in its
 * issuer, and a Google directory's hosted domain is the address's own, since sign-in refuses
 * any other.
 */
export function directoryIdOf(issuerUrl: string, domain: string) {
  const issuer = classifyIssuer(issuerUrl);
  if (issuer.kind === "entra") return issuer.tenantId;
  return issuer.kind === "google" ? domain : undefined;
}

export const federationFailureCodes = [
  "provider_not_found",
  "organization_disabled",
  "directory_mismatch",
  "guest_account",
  "personal_account",
  "email_unverified",
  "domain_not_allowed",
  "hosted_domain_mismatch",
  "user_disabled",
  "membership_revoked",
  "identity_conflict",
  "email_conflict",
] as const;

function reject(
  code: (typeof federationFailureCodes)[number],
  message: string,
): SSOUserResolution {
  return { action: "reject", code, message };
}

function stringClaim(
  claims: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = claims[name];
  return typeof value === "string" ? value : undefined;
}

async function membershipRevoked(
  database: DBTransactionAdapter,
  organizationId: string,
  userId: string,
) {
  const member = await database.findOne<{
    status: string;
    deletedAt?: Date | null;
  }>({
    model: "member",
    where: [
      { field: "organizationId", value: organizationId },
      { field: "userId", value: userId },
    ],
  });
  return member?.status === "revoked" || Boolean(member?.deletedAt);
}

/**
 * A person ID has not met, on any method: a directory's first sign-in, a magic link's in domain
 * mode, and staff importing an address. The same fields, so `sub`, which is the id these rows
 * get, and everything that reads them work alike. Whichever made the row has seen the mailbox
 * proved, or will before any token: no token exists for an imported person until they sign in.
 */
export const newUserFields = (person: {
  email: string;
  name?: string | null;
  image?: string | null;
}) => ({
  name: person.name || person.email,
  email: person.email,
  image: person.image,
  emailVerified: true,
  status: "active" as const,
});

export async function resolveFederatedUser(
  input: SSOUserResolutionInput,
  database: DBTransactionAdapter,
  linkUserId?: string,
): Promise<SSOUserResolution> {
  if (input.protocol !== "oidc") throw new Error("OIDC provider required");
  const provider = await database.findOne<ProviderRow>({
    model: "ssoProvider",
    where: [{ field: "providerId", value: input.providerId }],
  });
  if (!provider) return reject("provider_not_found", "Provider not found");

  const organization = await database.findOne<OrganizationRow>({
    model: "organization",
    where: [{ field: "id", value: provider.organizationId }],
  });
  if (
    !organization ||
    organization.deletedAt ||
    organization.status !== "active"
  ) {
    return reject("organization_disabled", "Organization is disabled");
  }

  const claims = input.verifiedIdTokenClaims;
  const issuer = classifyIssuer(input.accountKey.issuer);
  const subject = stringClaim(claims, "sub") ?? input.accountKey.accountId;
  let directoryId: string | undefined;
  let directoryUserId = subject;

  if (issuer.kind === "entra") {
    const tenantId = stringClaim(claims, "tid");
    if (tenantId !== issuer.tenantId) {
      return reject("directory_mismatch", "Directory does not match");
    }
    if (claims.idp !== undefined || claims.acct === 1) {
      return reject("guest_account", "Guest accounts are not allowed");
    }
    directoryId = tenantId;
    directoryUserId = stringClaim(claims, "oid") ?? subject;
  } else {
    if (issuer.kind === "google") {
      const hostedDomain = stringClaim(claims, "hd");
      if (!hostedDomain) {
        return reject("personal_account", "Personal accounts are not allowed");
      }
      directoryId = hostedDomain;
    }
    if (claims.email_verified !== true) {
      return reject("email_unverified", "Email is not verified");
    }
  }

  const email = input.providerUser.email.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    throw new Error("Provider returned an invalid email");
  }
  const domain = email.slice(at + 1);
  const allowedDomain = await database.findOne({
    model: "organizationDomain",
    where: [
      { field: "organizationId", value: provider.organizationId },
      { field: "domain", value: domain },
      { field: "status", value: "active" },
    ],
  });
  if (!allowedDomain) {
    return reject("domain_not_allowed", "Email domain is not allowed");
  }
  if (issuer.kind === "google" && stringClaim(claims, "hd") !== domain) {
    return reject("hosted_domain_mismatch", "Hosted domain does not match");
  }

  const exactAccount = await database.findOne<AccountRow>({
    model: "account",
    where: [
      { field: "issuer", value: input.accountKey.issuer },
      { field: "accountId", value: input.accountKey.accountId },
    ],
    join: { user: true },
  });
  if (exactAccount) {
    if (linkUserId)
      return reject("identity_conflict", "Identity is already bound");
    const owner = exactAccount.user;
    if (
      !owner ||
      exactAccount.deletedAt ||
      owner.deletedAt ||
      owner.status !== "active"
    ) {
      return reject("user_disabled", "User is disabled");
    }
    if (await membershipRevoked(database, provider.organizationId, owner.id))
      return reject("membership_revoked", "Organisation membership is revoked");
    // Better Auth finds the account by provider and subject, so it would not
    // find this one and would try to create another user.
    if (exactAccount.providerId !== input.providerId)
      return reject("identity_conflict", "Identity is already bound");
    return { action: "continue" };
  }

  // Another account already holds this directory identity, for example an
  // Entra object whose subject changed with the application. Binding imported
  // placeholders instead waits for import tooling: docs/02-plan.md.
  const holder = await database.findOne<AccountRow>({
    model: "account",
    where: [
      { field: "issuer", value: input.accountKey.issuer },
      { field: "directoryUserId", value: directoryUserId },
    ],
  });
  if (holder) return reject("identity_conflict", "Identity is already bound");

  if (linkUserId) {
    // Only the verified-purpose boundary can supply this independently proven
    // user. Email is neither a lookup nor a merge instruction for a link.
    await database.create({
      model: "account",
      data: {
        userId: linkUserId,
        providerId: input.providerId,
        issuer: input.accountKey.issuer,
        accountId: input.accountKey.accountId,
        directoryId,
        directoryUserId,
      },
    });
    return { action: "link", userId: linkUserId, profile: "preserve" };
  }

  const emailUser = await database.findOne<UserRow>({
    model: "user",
    where: [{ field: "email", value: email }],
  });
  // Any holder keeps the address, a disabled person included: staff free it by
  // retiring it once the previous holder is disabled. This transaction rolls back, so what a
  // mailbox proof would need of this verified sign-in leaves it in memory.
  if (emailUser) {
    noteRefusedIdentity({
      organizationId: provider.organizationId,
      providerId: provider.id,
      providerRevision: provider.revision,
      email,
      issuer: input.accountKey.issuer,
      subject: input.accountKey.accountId,
      directoryUserId,
    });
    return reject("email_conflict", "Email is already in use");
  }

  const user = await database.create<{ id: string }>({
    model: "user",
    data: newUserFields({
      email,
      name: input.providerUser.name,
      image: input.providerUser.image,
    }),
  });
  await database.create({
    model: "account",
    data: {
      userId: user.id,
      providerId: input.providerId,
      issuer: input.accountKey.issuer,
      accountId: input.accountKey.accountId,
      directoryId,
      directoryUserId,
    },
  });
  return { action: "continue" };
}
