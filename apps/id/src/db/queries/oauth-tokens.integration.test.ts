import {
  inPlatformUsers,
  inPlatformWrite,
} from "../../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createId } from "../../lib/id.ts";
import {
  users,
  oauthClients,
  oauthRefreshTokens,
  oauthAccessTokens,
} from "../schema/index.ts";

let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, security_identifiers, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});

import { revokeUserTokens, revokeClientTokens } from "./oauth-tokens.ts";

test("revokes only live tokens by user or client, with exact counts and no double counting", async () => {
  const db = connection.db;
  const userIds = [createId(), createId()];
  for (const id of userIds)
    await db
      .insert(users)
      .values({ id, name: "User", email: id + "@example.com" });
  for (const clientId of ["a", "b"])
    await db
      .insert(oauthClients)
      .values({ id: createId(), clientId, redirectUris: [] });
  const old = new Date("2020-01-01T00:00:00Z");
  for (const clientId of ["a", "b"])
    for (const userId of userIds)
      for (const revoked of [null, old]) {
        const values = {
          id: createId(),
          token: createId(),
          clientId,
          userId,
          scopes: [],
          expiresAt: new Date(Date.now() + 60000),
          revoked,
        };
        await db.insert(oauthRefreshTokens).values(values);
        await db
          .insert(oauthAccessTokens)
          .values({ ...values, id: createId(), token: createId() });
      }
  await db.insert(oauthAccessTokens).values({
    id: createId(),
    clientId: "a",
    scopes: [],
    expiresAt: new Date(Date.now() + 60000),
  });
  const expected = async (
    table: typeof oauthAccessTokens | typeof oauthRefreshTokens,
  ) =>
    (
      await db
        .select({ id: table.id, userId: table.userId, revoked: table.revoked })
        .from(table)
    )
      .filter((row) => row.userId === userIds[0] && row.revoked === null)
      .map(({ id, userId }) => ({ id, userId: userId! }));
  const expectedAccess = await expected(oauthAccessTokens);
  const expectedRefresh = await expected(oauthRefreshTokens);
  const first = await inPlatformUsers(db, (context) =>
    revokeUserTokens(context, userIds[0]),
  );
  first.revokedTokens.access.sort((a, b) => a.id.localeCompare(b.id));
  first.revokedTokens.refresh.sort((a, b) => a.id.localeCompare(b.id));
  expect(first).toEqual({
    refreshTokens: 2,
    accessTokens: 2,
    revokedTokens: {
      access: expectedAccess.sort((a, b) => a.id.localeCompare(b.id)),
      refresh: expectedRefresh.sort((a, b) => a.id.localeCompare(b.id)),
    },
  });
  expect(
    await inPlatformUsers(db, (context) =>
      revokeUserTokens(context, userIds[0]),
    ),
  ).toEqual({
    refreshTokens: 0,
    accessTokens: 0,
    revokedTokens: { access: [], refresh: [] },
  });
  expect(
    await inPlatformWrite(db, (context) => revokeClientTokens(context, "a")),
  ).toMatchObject({
    refreshTokens: 1,
    accessTokens: 2,
  });
  expect(
    await inPlatformWrite(db, (context) => revokeClientTokens(context, "a")),
  ).toEqual({
    refreshTokens: 0,
    accessTokens: 0,
    revokedTokens: { access: [], refresh: [] },
  });
  for (const table of [oauthRefreshTokens, oauthAccessTokens]) {
    const rows = await db.select().from(table);
    expect(
      rows.filter((r) => r.revoked?.getTime() === old.getTime()),
    ).toHaveLength(4);
    expect(rows.filter((r) => r.revoked === null)).toHaveLength(1);
    expect(
      (await db.select().from(table).where(eq(table.clientId, "a"))).every(
        (r) => r.revoked,
      ),
    ).toBe(true);
  }
});

import { sessions } from "../schema/index.ts";
import { revokeSessionTokens } from "./oauth-tokens.ts";

test("revokes only live tokens of selected sessions and preserves other and unbound tokens", async () => {
  const db = connection.db;
  const userId = createId();
  await db
    .insert(users)
    .values({ id: userId, name: "User", email: "session@example.com" });
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId: "session-client", redirectUris: [] });
  const ids = [createId(), createId()];
  for (const id of ids)
    await db.insert(sessions).values({
      id,
      userId,
      token: id,
      expiresAt: new Date(Date.now() + 60000),
    });
  const old = new Date("2000-01-01");
  for (const sessionId of [...ids, null])
    for (const revoked of [null, old]) {
      const value = {
        id: createId(),
        userId,
        sessionId,
        revoked,
        token: createId(),
        clientId: "session-client",
        scopes: [],
        expiresAt: new Date(Date.now() + 60000),
      };
      await db.insert(oauthRefreshTokens).values(value);
      await db.insert(oauthAccessTokens).values({ ...value, id: createId() });
    }
  expect(
    await inPlatformUsers(db, (context) =>
      revokeSessionTokens(context, ids[0]),
    ),
  ).toMatchObject({
    refreshTokens: 1,
    accessTokens: 1,
  });
  expect(
    await inPlatformUsers(db, (context) =>
      revokeSessionTokens(context, ids[0]),
    ),
  ).toEqual({
    refreshTokens: 0,
    accessTokens: 0,
    revokedTokens: { access: [], refresh: [] },
  });
  for (const table of [oauthRefreshTokens, oauthAccessTokens]) {
    const rows = await db.select().from(table);
    expect(rows.filter((r) => r.revoked === null)).toHaveLength(2);
    expect(
      rows.filter((r) => r.revoked?.getTime() === old.getTime()),
    ).toHaveLength(3);
  }
});
