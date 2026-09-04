import type { SSOUserResolutionInput, SSOUserResolution } from "@better-auth/sso";
import type { DBTransactionAdapter } from "better-auth";

import { retiredEmailFor } from "../db/queries/users.ts";

type ProviderRow = {
  id: string;
  organizationId: string;
};

type OrganizationRow = {
  id: string;
  status: "active" | "disabled";
};

type UserRow = {
  id: string;
  email: string;
  status: "inert" | "active" | "disabled";
};

type AccountRow = {
  id: string;
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

function reject(code: string, message: string): SSOUserResolution {
  return { action: "reject", code, message };
}

function stringClaim(
  claims: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = claims[name];
  return typeof value === "string" ? value : undefined;
}

function userFrom(account: AccountRow): UserRow {
  if (!account.user) throw new Error("Federated account has no owner");
  return account.user;
}

async function fillDirectoryColumns(
  database: DBTransactionAdapter,
  account: AccountRow,
  directoryId: string | undefined,
  directoryUserId: string,
) {
  const update: Record<string, string> = {};
  if (!account.directoryId && directoryId) update.directoryId = directoryId;
  if (!account.directoryUserId) update.directoryUserId = directoryUserId;
  if (Object.keys(update).length > 0) {
    await database.update({
      model: "account",
      where: [{ field: "id", value: account.id }],
      update,
    });
  }
}

export async function resolveFederatedUser(
  input: SSOUserResolutionInput,
  database: DBTransactionAdapter,
): Promise<SSOUserResolution> {
  if (input.protocol !== "oidc") {
    return reject("provider_not_found", "OIDC provider required");
  }
  const provider = await database.findOne<ProviderRow>({
    model: "ssoProvider",
    where: [{ field: "providerId", value: input.providerId }],
  });
  if (!provider) return reject("provider_not_found", "Provider not found");

  const organization = await database.findOne<OrganizationRow>({
    model: "organization",
    where: [{ field: "id", value: provider.organizationId }],
  });
  if (!organization || organization.status !== "active") {
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
  if (
    issuer.kind === "google" &&
    stringClaim(claims, "hd") !== domain
  ) {
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
    const owner = userFrom(exactAccount);
    if (owner.status === "disabled") {
      return reject("user_disabled", "User is disabled");
    }
    if (owner.status === "inert") {
      await database.update({
        model: "user",
        where: [{ field: "id", value: owner.id }],
        update: { status: "active", emailVerified: true },
      });
    }
    await fillDirectoryColumns(
      database,
      exactAccount,
      directoryId,
      directoryUserId,
    );
    return { action: "continue" };
  }

  const placeholder = await database.findOne<AccountRow>({
    model: "account",
    where: [
      { field: "issuer", value: input.accountKey.issuer },
      { field: "directoryUserId", value: directoryUserId },
    ],
    join: { user: true },
  });
  if (placeholder) {
    const owner = userFrom(placeholder);
    if (owner.status === "disabled") {
      return reject("user_disabled", "User is disabled");
    }
    if (owner.status !== "inert") {
      return reject("identity_conflict", "Identity is already bound");
    }
    await database.update({
      model: "account",
      where: [{ field: "id", value: placeholder.id }],
      update: {
        accountId: input.accountKey.accountId,
        ...(directoryId ? { directoryId } : {}),
      },
    });
    await database.update({
      model: "user",
      where: [{ field: "id", value: owner.id }],
      update: { status: "active", emailVerified: true },
    });
    return { action: "continue" };
  }

  const emailUser = await database.findOne<UserRow>({
    model: "user",
    where: [{ field: "email", value: email }],
  });
  if (emailUser?.status === "disabled") {
    await database.update({
      model: "user",
      where: [{ field: "id", value: emailUser.id }],
      update: {
        email: retiredEmailFor(emailUser.id),
        retiredEmail: emailUser.email,
      },
    });
  } else if (emailUser) {
    return reject("email_conflict", "Email is already in use");
  }

  const user = await database.create<{ id: string }>({
    model: "user",
    data: {
      name: input.providerUser.name || email,
      email,
      image: input.providerUser.image,
      emailVerified: true,
      status: "active",
    },
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
