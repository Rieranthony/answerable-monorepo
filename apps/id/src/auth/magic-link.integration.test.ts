import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { like } from "drizzle-orm";

import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { verifications } from "../db/schema/index.ts";
import { issueMagicLinkToken, magicLinkIdentifier } from "./magic-link.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 2 },
    { originChecks: true, restrictedRole: true },
  );
});
afterAll(() => fixture?.close());

const origin = () => fixture.environment.betterAuthUrl;
const email = "person@routes.example.com";

test("the plugin's native routes answer 404 from outside, on every method", async () => {
  const token = await issueMagicLinkToken(fixture.auth, email);
  const before = await fixture.db
    .select()
    .from(verifications)
    .where(like(verifications.identifier, "magic-link:%"));
  expect(before.map((row) => row.identifier)).toContain(
    magicLinkIdentifier(token),
  );
  for (const [path, init] of [
    ["/auth/sign-in/magic-link", { method: "POST" }],
    ["/auth/sign-in/magic-link", { method: "GET" }],
    [`/auth/magic-link/verify?token=${token}`, { method: "GET" }],
    [`/auth/magic-link/verify?token=${token}`, { method: "POST" }],
  ] as const) {
    const response = await fixture.app.fetch(
      new Request(`${origin()}${path}`, {
        ...init,
        headers: {
          origin: origin(),
          "content-type": "application/json",
        },
        ...(init.method === "POST" ? { body: JSON.stringify({ email }) } : {}),
      }),
    );
    expect(response.status).toBe(404);
  }
  // Nothing consumed, nothing new.
  expect(
    await fixture.db
      .select()
      .from(verifications)
      .where(like(verifications.identifier, "magic-link:%")),
  ).toEqual(before);
});

test("neither route is in either served OpenAPI document or its snapshot", async () => {
  for (const path of ["/openapi.json", "/api/admin/openapi.json"]) {
    const served = await fixture.app.fetch(new Request(`${origin()}${path}`));
    expect(served.status).toBe(200);
    expect(await served.text()).not.toContain("magic-link/verify");
  }
  const snapshot = readFileSync(
    new URL("../../openapi.json", import.meta.url),
    "utf8",
  );
  expect(snapshot).not.toContain("sign-in/magic-link");
  expect(snapshot).not.toContain("magic-link/verify");
});

test("the plugin stores only the hash, and an expired row stays until the sweep: no read cleans it", async () => {
  const token = await issueMagicLinkToken(fixture.auth, email);
  const [row] = await fixture.db
    .select()
    .from(verifications)
    .where(like(verifications.identifier, magicLinkIdentifier(token)));
  expect(JSON.stringify(row)).not.toContain(token);

  await fixture.db
    .update(verifications)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(like(verifications.identifier, magicLinkIdentifier(token)));
  const { internalAdapter } = await fixture.auth.$context;
  await internalAdapter.findVerificationValue("some-other-identifier");
  expect(
    await fixture.db
      .select({ id: verifications.id })
      .from(verifications)
      .where(like(verifications.identifier, magicLinkIdentifier(token))),
  ).toHaveLength(1);
});

test("a call to the plugin from anywhere but ID's issue refuses, having nothing to hand the token to", async () => {
  await expect(
    fixture.auth.api.signInMagicLink({
      body: { email },
      headers: new Headers(),
    }),
  ).rejects.toBeDefined();
});
