import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import {
  inPlatformRead,
  inPlatformUsers,
  inPlatformWrite,
} from "../../__tests__/platform-context.ts";
import { inTenant, inTenantRead } from "../../__tests__/tenant-command.ts";
import * as tokens from "./oauth-tokens.ts";
import { revokeMemberGrantContexts } from "./grant-contexts.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});

test("revocation queries reject raw database authority", async () => {
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(tokens.revokeUserTokens, undefined, [
        fixture.db,
        crypto.randomUUID(),
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("revocation authority cannot be copied, reused or substituted across purposes", async () => {
  const id = crypto.randomUUID();
  const userWrites = [tokens.revokeUserTokens, tokens.revokeSessionTokens];
  const platformWrites = [
    tokens.revokeClientTokens,
    tokens.revokeOrganizationMachineTokens,
  ];
  const tenantWrites = [revokeMemberGrantContexts];
  const all = [...userWrites, ...platformWrites, ...tenantWrites];
  async function reject(context: unknown, cases = all) {
    for (const fn of cases)
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(fn, undefined, [context, id]),
        ),
      ).rejects.toThrow("Invalid or expired");
  }
  await reject(null);
  await reject(fixture.db);
  let expired: unknown;
  await inPlatformRead(fixture.db, async (context) => {
    expired = context;
    await reject(context);
    await reject({ ...context });
  });
  await reject(expired);
  await inPlatformUsers(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context });
    await reject(context, [...platformWrites, ...tenantWrites]);
    for (const fn of userWrites)
      expect(await fn(context, id)).toEqual({
        refreshTokens: 0,
        accessTokens: 0,
        revokedTokens: { access: [], refresh: [] },
      });
  });
  await reject(expired);
  await inPlatformWrite(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context });
    await reject(context, [...userWrites, ...tenantWrites]);
    expect(await tokens.revokeClientTokens(context, id)).toEqual({
      refreshTokens: 0,
      accessTokens: 0,
      revokedTokens: { access: [], refresh: [] },
    });
    expect(await tokens.revokeOrganizationMachineTokens(context, id)).toEqual(
      [],
    );
  });
  await reject(expired);
  await inTenant(fixture.db, fixture.tenant.organizationId, async (context) => {
    expired = context;
    await reject({ ...context });
    await reject(context, [...userWrites, ...platformWrites]);
    expect(await revokeMemberGrantContexts(context, id)).toEqual([]);
  });
  await reject(expired);
  for (const access of [
    "directory",
    "configuration",
    "memberAccess",
    "history",
  ] as const) {
    await inTenantRead(
      fixture.db,
      fixture.tenant.organizationId,
      access,
      async (context) => {
        expired = context;
        await reject(context);
        await reject({ ...context });
      },
    );
    await reject(expired);
  }
});

test("grant mutation queries reject raw authority", async () => {
  const { revokeUserGrantContexts } = await import("./grant-contexts.ts");
  await expect(
    Promise.resolve().then(() =>
      Reflect.apply(revokeUserGrantContexts, undefined, [
        fixture.db,
        crypto.randomUUID(),
      ]),
    ),
  ).rejects.toThrow("Invalid or expired");
});

test("grant mutation queries require their exact issued command purpose", async () => {
  const grants = await import("./grant-contexts.ts");
  const id = crypto.randomUUID();
  const userWrites = [
    grants.revokeUserGrantContexts,
    grants.revokeSessionGrantContexts,
  ];
  const platformWrites = [
    grants.revokeUserAndOwnedClientGrantContexts,
    grants.revokeOrganizationGrantContexts,
    grants.revokeResourceGrantContexts,
    grants.revokeClientGrantContexts,
  ];
  const all = [...userWrites, ...platformWrites];
  async function reject(context: unknown, cases = all) {
    for (const fn of cases)
      await expect(
        Promise.resolve().then(() =>
          Reflect.apply(fn, undefined, [context, id, id]),
        ),
      ).rejects.toThrow("Invalid or expired");
  }
  await reject(null);
  await reject(fixture.db);
  let expired: unknown;
  await inPlatformRead(fixture.db, async (context) => {
    expired = context;
    await reject(context);
    await reject({ ...context });
  });
  await reject(expired);
  await inPlatformUsers(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context });
    await reject(context, platformWrites);
    expect(await grants.revokeUserGrantContexts(context, id)).toEqual([]);
    expect(await grants.revokeSessionGrantContexts(context, id, id)).toEqual(
      [],
    );
  });
  await reject(expired);
  await inPlatformWrite(fixture.db, async (context) => {
    expired = context;
    await reject({ ...context });
    await reject(context, userWrites);
    for (const fn of platformWrites) expect(await fn(context, id)).toEqual([]);
  });
  await reject(expired);
  await inTenant(fixture.db, fixture.tenant.organizationId, async (context) => {
    expired = context;
    await reject(context);
    await reject({ ...context });
  });
  await reject(expired);
  for (const access of [
    "directory",
    "configuration",
    "memberAccess",
    "history",
  ] as const) {
    await inTenantRead(
      fixture.db,
      fixture.tenant.organizationId,
      access,
      async (context) => {
        expired = context;
        await reject(context);
        await reject({ ...context });
      },
    );
    await reject(expired);
  }
});
