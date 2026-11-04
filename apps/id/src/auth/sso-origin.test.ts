import { expect, test } from "bun:test";
import { createSsoOriginBoundary } from "./sso-origin.ts";

test("session input cannot manufacture origin without trusted resolution", async () => {
  const boundary = createSsoOriginBoundary();
  const session = {
    id: "session",
    userId: "user",
    token: "token",
    ipAddress: "192.0.2.1",
    userAgent: "Browser",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(),
    authenticationOrganizationId: "forged-tenant",
    authenticationProviderId: "forged-provider",
    authenticationProviderRevision: 1,
  };
  for (const context of [
    null,
    { context: { adapter: {} } },
    { path: "/sso/callback", context: { adapter: {} } },
  ] as Parameters<typeof boundary.before>[1][])
    await expect(boundary.before(session, context)).rejects.toMatchObject({
      body: { code: "authentication_origin_missing" },
    });
});
