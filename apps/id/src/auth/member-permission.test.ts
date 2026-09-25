import { expect, test } from "bun:test";
import {
  evaluateClientLoginPermission as login,
  evaluateUserResourcePermission as resource,
  evaluateAdminPermission as admin,
  memberPermissionView,
} from "./member-permission.ts";

function facts(): Parameters<typeof login>[0] {
  const source = {
    id: "source",
    revision: 1,
    validFrom: null,
    validUntil: null,
  };
  const identity = ["openid", "offline_access"];
  return {
    organization: { id: "org", authorizationVersion: 1 },
    userId: "user",
    client: {
      id: "client",
      clientId: "client",
      revision: 1,
      authorizationVersion: 1,
      scopeCeiling: [...identity, "email", "read", "write"],
    },
    resource: {
      id: "resource",
      identifier: "service",
      revision: 1,
      scopeCeiling: ["read", "write"],
    },
    loginEligible: true,
    adminEligible: true,
    eligible: true,
    refreshEnabled: true,
    membership: { ...source },
    evaluatedAt: "2026-09-25",
    capabilities: [
      {
        ...source,
        resource: null,
        grantKind: "authorization_code",
        scopes: identity,
      },
      {
        ...source,
        resource: "service",
        grantKind: "authorization_code",
        scopes: ["read", "write"],
      },
      {
        ...source,
        resource: "service",
        grantKind: "admin_session",
        scopes: ["read"],
      },
    ],
    assignments: [null, "service"].map((resource) => ({
      ...source,
      resource,
      scopes: resource ? ["read"] : identity,
      memberId: null,
      groupId: null,
      groupMembership: null,
    })),
  };
}
const request = {
  grantType: "authorization_code" as const,
  requestedScopes: ["openid", "offline_access", "read", "write"],
  originalScopes: ["openid", "offline_access", "read", "write", "email"],
};

test("resource requests are exact at issuance and narrowed at authorisation", () => {
  expect(resource(facts(), { ...request, resource: "service" })).toMatchObject({
    allowed: false,
    reason: "scope",
  });
  const decision = resource(facts(), {
    ...request,
    resource: "service",
    narrow: true,
  });
  expect(decision).toMatchObject({
    allowed: true,
    scopes: ["read"],
    grantedScopes: ["offline_access", "openid", "read"],
    requestedScopes: ["offline_access", "openid", "read", "write"],
  });
  expect(memberPermissionView(decision)).not.toHaveProperty("grantedScopes");
  expect(
    resource(facts(), {
      ...request,
      resource: "service",
      narrow: true,
      requestedScopes: ["write"],
    }),
  ).toMatchObject({ allowed: false, reason: "scope" });
  expect(
    resource(facts(), {
      ...request,
      resource: "service",
      requestedScopes: ["email", "read"],
    }),
  ).toMatchObject({ allowed: false, reason: "login" });
  expect(
    resource(facts(), {
      ...request,
      resource: "service",
      narrow: true,
      requestedScopes: ["email", "read"],
    }),
  ).toMatchObject({ allowed: true, grantedScopes: ["read"] });
  // Scopes beyond the grant's original request are refused, never narrowed.
  expect(
    resource(facts(), {
      ...request,
      resource: "service",
      narrow: true,
      originalScopes: ["openid", "read"],
    }),
  ).toMatchObject({ allowed: false, reason: "scope" });
});

test("login requests drop unapproved identity scopes only when narrowing", () => {
  const input = { ...request, requestedScopes: ["email", "openid"] };
  expect(login(facts(), input)).toMatchObject({
    allowed: false,
    reason: "login",
  });
  expect(login(facts(), { ...input, narrow: true })).toMatchObject({
    allowed: true,
    scopes: ["openid"],
    grantedScopes: ["openid"],
  });
  expect(
    login(facts(), { ...input, narrow: true, requestedScopes: ["email"] }),
  ).toMatchObject({ allowed: false, reason: "login" });
  expect(
    login(facts(), { ...input, requestedScopes: ["openid"] }),
  ).toMatchObject({ allowed: true, grantedScopes: ["openid"] });
  expect(
    login(facts(), { ...input, narrow: true, originalScopes: ["openid"] }),
  ).toMatchObject({ allowed: false, reason: "login" });
});

test("access explanations have no granted request and their public shape is unchanged", () => {
  for (const decision of [
    login(facts()),
    resource(facts(), {
      resource: "service",
      grantType: "authorization_code",
    }),
    admin(facts()),
  ]) {
    expect(decision).toMatchObject({ allowed: true, grantedScopes: null });
    expect(memberPermissionView(decision)).not.toHaveProperty("grantedScopes");
  }
  expect(
    memberPermissionView(login({ ...facts(), loginEligible: false })),
  ).toEqual({ allowed: false, reason: "context" });
});

test("narrowing preserves admission, exact-pair capabilities and refresh requirements", () => {
  const input = { ...request, resource: "service", narrow: true };
  expect(resource({ ...facts(), loginEligible: false }, input)).toMatchObject({
    allowed: false,
    reason: "context",
  });
  const row = facts();
  row.capabilities = row.capabilities.filter((cap) => cap.resource === null);
  expect(resource(row, input)).toMatchObject({
    allowed: false,
    reason: "capability",
  });
  expect(
    resource(facts(), { ...input, grantType: "refresh_token" }),
  ).toMatchObject({ allowed: false, reason: "capability" });
  expect(
    login(facts(), { ...request, narrow: true, grantType: "refresh_token" }),
  ).toMatchObject({ allowed: false, reason: "capability" });
  expect(
    resource(facts(), {
      resource: "service",
      grantType: "authorization_code",
      requestedScopes: ["openid", "read"],
      narrow: true,
    }),
  ).toMatchObject({ allowed: true, grantedScopes: ["openid", "read"] });
});
