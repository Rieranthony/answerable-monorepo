import { expect, test } from "bun:test";
import { createSsoOriginBoundary } from "./sso-origin.ts";

test("session input cannot manufacture origin without trusted resolution", async () => {
  const boundary = createSsoOriginBoundary();
  const session = {
    id: "session",
    userId: "user",
    token: "token",
    ipAddress: "192.0.2.1",
    userAgent: "x".repeat(513),
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(),
    authenticationOrganizationId: "forged-tenant",
    authenticationProviderId: "forged-provider",
    authenticationProviderRevision: 1,
  };
  for (const context of [
    null,
    { context: { adapter: {} } } as Parameters<typeof boundary.before>[1],
  ]) {
    expect(await boundary.before(session, context)).toMatchObject({
      data: {
        ipAddress: null,
        userAgent: null,
        authenticationOrganizationId: null,
        authenticationProviderId: null,
        authenticationProviderRevision: null,
      },
    });
  }
  await expect(
    boundary.before(session, {
      path: "/sso/callback",
      context: { adapter: {} },
    } as Parameters<typeof boundary.before>[1]),
  ).rejects.toMatchObject({
    body: { code: "authentication_origin_missing" },
  });
});
