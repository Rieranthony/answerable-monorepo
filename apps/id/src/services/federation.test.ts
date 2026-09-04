import { describe, expect, test } from "bun:test";
import type { SSOOIDCUserResolutionInput } from "@better-auth/sso";
import type { DBTransactionAdapter } from "better-auth";

import { classifyIssuer, resolveFederatedUser } from "./federation.ts";

const tenantId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";

function input(
  overrides: Partial<SSOOIDCUserResolutionInput> = {},
): SSOOIDCUserResolutionInput {
  return {
    protocol: "oidc",
    providerId: "contoso",
    accountKey: {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      accountId: "upstream-subject",
    },
    providerUser: {
      email: " Person@Contoso.com ",
      emailVerified: false,
      name: "Test Person",
    },
    providerClaims: {},
    verifiedIdTokenClaims: {
      sub: "upstream-subject",
      oid: "directory-user",
      tid: tenantId,
    },
    providerReference: {
      providerId: "contoso",
      source: { type: "persisted", recordId: "provider-row" },
      authenticationConfigurationFingerprint: "fingerprint",
    },
    ...overrides,
  };
}

function databaseWithFinds(...results: unknown[]): DBTransactionAdapter {
  let index = 0;
  return {
    findOne: async () => (results[index++] ?? null) as never,
    create: async () => {
      throw new Error("unexpected create");
    },
    update: async () => {
      throw new Error("unexpected update");
    },
  } as unknown as DBTransactionAdapter;
}

function recordingDatabase(...results: unknown[]) {
  let index = 0;
  const updates: Array<Record<string, unknown>> = [];
  const creates: Array<Record<string, unknown>> = [];
  const database = {
    findOne: async () => (results[index++] ?? null) as never,
    update: async (operation: Record<string, unknown>) => {
      updates.push(operation);
      return operation as never;
    },
    create: async (operation: Record<string, unknown>) => {
      creates.push(operation);
      return (operation.model === "user" ? { id: "new-user" } : operation) as never;
    },
  } as unknown as DBTransactionAdapter;
  return { database, updates, creates };
}

const provider = {
  id: "provider-row",
  providerId: "contoso",
  organizationId,
};
const organization = { id: organizationId, status: "active" };
const domain = { id: "domain-row", domain: "contoso.com", status: "active" };

describe("unit: federated user resolution", () => {
  test("fails closed for a non-OIDC resolver input", async () => {
    const result = await resolveFederatedUser(
      {
        protocol: "saml",
        providerId: "contoso",
        accountKey: { issuer: "saml-issuer", accountId: "name-id" },
        providerUser: {
          email: "person@contoso.com",
          emailVerified: true,
          name: "Person",
        },
        providerAttributes: {},
        providerReference: {
          providerId: "contoso",
          source: { type: "configured" },
          authenticationConfigurationFingerprint: "fingerprint",
        },
      },
      databaseWithFinds(),
    );
    expect(result).toMatchObject({ action: "reject", code: "provider_not_found" });
  });

  test("classifies tenant-scoped Entra, Google, and generic OIDC issuers", () => {
    expect(
      classifyIssuer(
        `https://login.microsoftonline.com/${tenantId}/v2.0`,
      ),
    ).toEqual({ kind: "entra", tenantId });
    expect(classifyIssuer("https://accounts.google.com")).toEqual({
      kind: "google",
    });
    expect(classifyIssuer("https://login.example.com")).toEqual({
      kind: "oidc",
    });
  });

  test("rejects a missing provider and a disabled organization", async () => {
    expect(
      await resolveFederatedUser(input(), databaseWithFinds(null)),
    ).toMatchObject({ action: "reject", code: "provider_not_found" });
    expect(
      await resolveFederatedUser(
        input(),
        databaseWithFinds(provider, { ...organization, status: "disabled" }),
      ),
    ).toMatchObject({ action: "reject", code: "organization_disabled" });
  });

  test("pins Entra tenants and rejects both guest signals", async () => {
    for (const claims of [
      { sub: "sub", oid: "oid", tid: "foreign-tenant" },
      { sub: "sub", oid: "oid", tid: tenantId, idp: "guest-issuer" },
      { sub: "sub", oid: "oid", tid: tenantId, acct: 1 },
    ]) {
      const result = await resolveFederatedUser(
        input({ verifiedIdTokenClaims: claims }),
        databaseWithFinds(provider, organization),
      );
      expect(result.action).toBe("reject");
      expect(result.action === "reject" ? result.code : "").toBe(
        claims.tid === "foreign-tenant" ? "directory_mismatch" : "guest_account",
      );
    }
  });

  test("pins Google hosted domains and verified email", async () => {
    const google = input({
      accountKey: {
        issuer: "https://accounts.google.com",
        accountId: "google-sub",
      },
      verifiedIdTokenClaims: {
        sub: "google-sub",
        email_verified: true,
      },
    });
    expect(
      await resolveFederatedUser(
        google,
        databaseWithFinds(provider, organization),
      ),
    ).toMatchObject({ action: "reject", code: "personal_account" });
    expect(
      await resolveFederatedUser(
        input({
          ...google,
          verifiedIdTokenClaims: {
            sub: "google-sub",
            hd: "contoso.com",
            email_verified: false,
          },
        }),
        databaseWithFinds(provider, organization),
      ),
    ).toMatchObject({ action: "reject", code: "email_unverified" });
    expect(
      await resolveFederatedUser(
        input({
          ...google,
          verifiedIdTokenClaims: {
            sub: "google-sub",
            hd: "other.example",
            email_verified: true,
          },
        }),
        databaseWithFinds(provider, organization, domain),
      ),
    ).toMatchObject({ action: "reject", code: "hosted_domain_mismatch" });
  });

  test("requires verified generic OIDC email and an active domain on the provider organization", async () => {
    const generic = input({
      accountKey: { issuer: "https://login.example.com", accountId: "subject" },
      verifiedIdTokenClaims: { sub: "subject", email_verified: false },
    });
    expect(
      await resolveFederatedUser(
        generic,
        databaseWithFinds(provider, organization),
      ),
    ).toMatchObject({ action: "reject", code: "email_unverified" });
    expect(
      await resolveFederatedUser(
        input({
          ...generic,
          verifiedIdTokenClaims: { sub: "subject", email_verified: true },
        }),
        databaseWithFinds(provider, organization, null),
      ),
    ).toMatchObject({ action: "reject", code: "domain_not_allowed" });
  });

  test("rejects a directory placeholder already owned by a non-inert user", async () => {
    const result = await resolveFederatedUser(
      input(),
      databaseWithFinds(
        provider,
        organization,
        domain,
        null,
        {
          id: "placeholder-account",
          userId: "owner",
          user: { id: "owner", status: "active" },
        },
      ),
    );

    expect(result).toMatchObject({ action: "reject", code: "identity_conflict" });
  });

  test("handles exact-account lifecycle and only fills empty directory columns", async () => {
    const disabled = await resolveFederatedUser(
      input(),
      databaseWithFinds(provider, organization, domain, {
        id: "account",
        userId: "user",
        user: { id: "user", email: "person@contoso.com", status: "disabled" },
      }),
    );
    expect(disabled).toMatchObject({ action: "reject", code: "user_disabled" });

    const active = recordingDatabase(provider, organization, domain, {
      id: "account",
      userId: "user",
      directoryId: tenantId,
      directoryUserId: "directory-user",
      user: { id: "user", email: "person@contoso.com", status: "active" },
    });
    expect(await resolveFederatedUser(input(), active.database)).toEqual({
      action: "continue",
    });
    expect(active.updates).toEqual([]);

    const inert = recordingDatabase(provider, organization, domain, {
      id: "account",
      userId: "user",
      directoryId: null,
      directoryUserId: null,
      user: { id: "user", email: "person@contoso.com", status: "inert" },
    });
    expect(await resolveFederatedUser(input(), inert.database)).toEqual({
      action: "continue",
    });
    expect(inert.updates).toHaveLength(2);
  });

  test("rejects disabled placeholders and activates inert placeholders", async () => {
    const disabled = await resolveFederatedUser(
      input(),
      databaseWithFinds(provider, organization, domain, null, {
        id: "placeholder",
        userId: "user",
        user: { id: "user", email: "person@contoso.com", status: "disabled" },
      }),
    );
    expect(disabled).toMatchObject({ action: "reject", code: "user_disabled" });

    const inert = recordingDatabase(provider, organization, domain, null, {
      id: "placeholder",
      userId: "user",
      user: { id: "user", email: "person@contoso.com", status: "inert" },
    });
    expect(await resolveFederatedUser(input(), inert.database)).toEqual({
      action: "continue",
    });
    expect(inert.updates).toHaveLength(2);
  });

  test("releases a disabled email holder and creates the exact account", async () => {
    const recorded = recordingDatabase(
      provider,
      organization,
      domain,
      null,
      null,
      {
        id: "old-user",
        email: "person@contoso.com",
        status: "disabled",
      },
    );

    expect(await resolveFederatedUser(input(), recorded.database)).toEqual({
      action: "continue",
    });
    expect(recorded.updates[0]).toMatchObject({
      model: "user",
      update: {
        email: "old-user@retired.invalid",
        retiredEmail: "person@contoso.com",
      },
    });
    expect(recorded.creates.map((operation) => operation.model)).toEqual([
      "user",
      "account",
    ]);
  });

  test("rejects active and inert email holders", async () => {
    for (const status of ["active", "inert"] as const) {
      const result = await resolveFederatedUser(
        input(),
        databaseWithFinds(
          provider,
          organization,
          domain,
          null,
          null,
          { id: "holder", email: "person@contoso.com", status },
        ),
      );
      expect(result).toMatchObject({ action: "reject", code: "email_conflict" });
    }
  });

  test("creates a Google user with the email fallback name", async () => {
    const recorded = recordingDatabase(
      provider,
      organization,
      domain,
      null,
      null,
      null,
    );
    const google = input({
      accountKey: {
        issuer: "https://accounts.google.com",
        accountId: "google-sub",
      },
      providerUser: {
        email: "person@contoso.com",
        emailVerified: false,
        name: "",
        image: null,
      },
      verifiedIdTokenClaims: {
        sub: "google-sub",
        hd: "contoso.com",
        email_verified: true,
      },
    });

    expect(await resolveFederatedUser(google, recorded.database)).toEqual({
      action: "continue",
    });
    expect(recorded.creates[0]).toMatchObject({
      model: "user",
      data: { name: "person@contoso.com", status: "active" },
    });
    expect(recorded.creates[1]).toMatchObject({
      model: "account",
      data: {
        directoryId: "contoso.com",
        directoryUserId: "google-sub",
      },
    });
  });

  test("throws when an account has no owner or the provider email is malformed", async () => {
    await expect(
      resolveFederatedUser(
        input(),
        databaseWithFinds(provider, organization, domain, {
          id: "orphan",
          userId: "missing",
        }),
      ),
    ).rejects.toThrow("Federated account has no owner");
    await expect(
      resolveFederatedUser(
        input({ providerUser: { email: "malformed", emailVerified: false, name: "" } }),
        databaseWithFinds(provider, organization),
      ),
    ).rejects.toThrow("Provider returned an invalid email");
  });
});
