import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAdminFixture } from "../__tests__/admin.ts";
import { createAuth } from "../auth.ts";
import { jwks, adminOperations } from "../db/schema/index.ts";
import { checkKeyCustody } from "./preflight.ts";

test("custody preflight reads retained provider, upstream and replay material without changing it", async () => {
  const fixture = await createAdminFixture();
  try {
    // General fixtures retain command reservations. This custody test needs only
    // its own ciphertext, without keys deliberately discarded by other tests.
    await fixture.db.execute(sql`truncate admin_operations cascade`);
    await createAuth(fixture.db, fixture.environment).api.getJwks();
    const created = await fixture.app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/groups`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fixture.environment.rootAdminSecret}`,
          "Idempotency-Key": crypto.randomUUID(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "preflight-proof", name: "Preflight" }),
      },
    );
    expect(created.status).toBe(201);
    const before = {
      keys: await fixture.db.select().from(jwks),
      operations: await fixture.db.select().from(adminOperations),
    };
    const result = await checkKeyCustody(fixture.db, fixture.environment);
    expect(result.signingKeys).toBeGreaterThan(0);
    expect(result.accounts).toBeGreaterThan(0);
    expect(result.replayResults).toBeGreaterThan(0);
    expect(await fixture.db.select().from(jwks)).toEqual(before.keys);
    expect(await fixture.db.select().from(adminOperations)).toEqual(
      before.operations,
    );
    for (const environment of [
      { ...fixture.environment, upstreamTokenSecrets: undefined },
      { ...fixture.environment, operationReplay: undefined },
      { ...fixture.environment, betterAuthSecret: "wrong".repeat(12) },
      {
        ...fixture.environment,
        upstreamTokenSecrets: [
          { version: 1, value: Buffer.alloc(32, 1).toString("base64url") },
        ],
      },
      {
        ...fixture.environment,
        operationReplay: {
          activeKeyId: "test",
          keys: { test: Buffer.alloc(32, 1).toString("base64url") },
        },
      },
    ])
      await expect(checkKeyCustody(fixture.db, environment)).rejects.toThrow(
        "Key custody preflight failed",
      );
    const first = before.keys[0]!;
    await fixture.db
      .update(jwks)
      .set({ publicKey: JSON.stringify({ kty: "invalid" }) })
      .where(eq(jwks.id, first.id));
    await expect(
      checkKeyCustody(fixture.db, fixture.environment),
    ).rejects.toThrow("Key custody preflight failed");
    await fixture.db
      .update(jwks)
      .set({ publicKey: first.publicKey })
      .where(eq(jwks.id, first.id));
    expect(await checkKeyCustody(fixture.db, fixture.environment)).toEqual(
      result,
    );
    await fixture.db.delete(jwks);
    await expect(
      checkKeyCustody(fixture.db, fixture.environment),
    ).rejects.toThrow("Key custody preflight failed");
    expect(await fixture.db.select().from(jwks)).toEqual([]);
    await createAuth(fixture.db, fixture.environment).api.getJwks();
  } finally {
    await fixture.close();
  }
});
