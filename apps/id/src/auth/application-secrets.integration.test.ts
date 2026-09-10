import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { signInThroughIdp } from "../__tests__/federation.ts";
import { createAdminFixture } from "../__tests__/admin.ts";
import { createAuth } from "../auth.ts";
import { createApp } from "../app.ts";
import { jwks } from "../db/schema/index.ts";

test("application secret rotation retains signing custody and requires new browser authentication when the active secret changes", async () => {
  const fixture = await createAdminFixture();
  try {
    const { db, environment } = fixture;
    const legacy = createAuth(db, environment);
    const oldToken = await legacy.api.signJWT({
      body: { payload: { sub: "rotation-proof", aud: "rotation-test" } },
    });
    const [oldKey] = await db.select().from(jwks);
    expect(oldKey).toBeDefined();
    const originalPublic = await importJWK(
      JSON.parse(oldKey!.publicKey),
      oldKey!.alg!,
    );
    const next = {
      version: 2,
      value: crypto.randomUUID() + crypto.randomUUID(),
    };
    const old = { version: 1, value: environment.betterAuthSecret };
    const staged = { ...environment, betterAuthSecrets: [old, next] };
    async function session(
      config: typeof environment,
      headers = fixture.headers("platformAdmin"),
    ) {
      const response = await createApp({
        auth: createAuth(db, config),
        db,
        environment: config,
      }).request("/auth/get-session", {
        headers,
      });
      expect(response.status).toBe(200);
      return response.json();
    }
    expect((await session(staged)).user.id).toBe(
      fixture.principals.platformAdmin.userId,
    );
    const promoted = { ...environment, betterAuthSecrets: [next, old] };
    // The pinned provider signs browser cookies with only its current secret.
    expect(await session(promoted)).toBeNull();
    const promotedApp = createApp({
      auth: createAuth(db, promoted),
      db,
      environment: promoted,
      ssoTest: { allowPrivateHosts: true },
    });
    fixture.issuer.enqueue({
      sub: "platformAdmin-subject",
      email: "platformadmin@answerable.example.com",
      email_verified: true,
      name: "platformAdmin",
    });
    const callbackURL = `${fixture.trustedOrigin}/callback`;
    const signedIn = await signInThroughIdp(promotedApp, {
      providerId: fixture.platform.slug,
      callbackURL,
    });
    expect(signedIn.location).toBe(callbackURL);
    const freshHeaders = new Headers({
      Cookie: signedIn.cookies
        .map((value) => value.split(";", 1)[0])
        .join("; "),
    });
    expect((await session(promoted, freshHeaders)).user.id).toBe(
      fixture.principals.platformAdmin.userId,
    );
    expect(await session(staged, freshHeaders)).toBeNull();

    const rotated = createAuth(db, promoted);
    const continuity = await rotated.api.signJWT({
      body: { payload: { sub: "rotation-proof", aud: "rotation-test" } },
    });
    expect(decodeProtectedHeader(continuity.token).kid).toBe(oldKey!.id);
    await jwtVerify(continuity.token, originalPublic, {
      issuer: environment.betterAuthUrl,
      audience: "rotation-test",
    });
    // Simulate a scheduled signing-key expiry; the provider owns replacement generation.
    await db
      .update(jwks)
      .set({ expiresAt: new Date(0) })
      .where(eq(jwks.id, oldKey!.id));
    const replacement = await rotated.api.signJWT({
      body: { payload: { sub: "rotation-proof", aud: "rotation-test" } },
    });
    const replacementId = decodeProtectedHeader(replacement.token).kid!;
    expect(replacementId).not.toBe(oldKey!.id);
    const [newKey] = await db
      .select()
      .from(jwks)
      .where(eq(jwks.id, replacementId));
    expect(JSON.parse(newKey!.privateKey)).toStartWith("$ba$2$");
    const third = {
      version: 3,
      value: crypto.randomUUID() + crypto.randomUUID(),
    };
    const retained = createAuth(db, {
      ...environment,
      betterAuthSecrets: [third, next],
    });
    const continued = await retained.api.signJWT({
      body: { payload: { sub: "rotation-proof", aud: "rotation-test" } },
    });
    expect(decodeProtectedHeader(continued.token).kid).toBe(replacementId);
    await jwtVerify(
      continued.token,
      await importJWK(JSON.parse(newKey!.publicKey), newKey!.alg!),
      { issuer: environment.betterAuthUrl, audience: "rotation-test" },
    );
    const lost = createAuth(db, { ...environment, betterAuthSecrets: [third] });
    await expect(
      lost.api.signJWT({ body: { payload: { sub: "rotation-proof" } } }),
    ).rejects.toThrow();
    expect(
      await db.select().from(jwks).where(eq(jwks.id, replacementId)),
    ).toEqual([newKey!]);
    await jwtVerify(oldToken.token, originalPublic, {
      issuer: environment.betterAuthUrl,
      audience: "rotation-test",
    });
  } finally {
    // This fixture starts with an empty JWKS table; do not leak its private ring to later tests.
    try {
      await fixture.db.delete(jwks);
    } finally {
      await fixture.close();
    }
  }
});
