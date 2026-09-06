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
  await connection.db.execute(sql`truncate table organizations, users cascade`);
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
  expect(await revokeUserTokens(db, [])).toEqual({
    refreshTokens: 0,
    accessTokens: 0,
  });
  expect(await revokeClientTokens(db, [])).toEqual({
    refreshTokens: 0,
    accessTokens: 0,
  });
  expect(await revokeUserTokens(db, [userIds[0]])).toEqual({
    refreshTokens: 2,
    accessTokens: 2,
  });
  expect(await revokeUserTokens(db, [userIds[0]])).toEqual({
    refreshTokens: 0,
    accessTokens: 0,
  });
  expect(await revokeClientTokens(db, ["a"])).toEqual({
    refreshTokens: 1,
    accessTokens: 2,
  });
  expect(await revokeClientTokens(db, ["a"])).toEqual({
    refreshTokens: 0,
    accessTokens: 0,
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
