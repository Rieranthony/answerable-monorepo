import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { createAuth } from "../auth.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { assertDisposableTestDatabase } from "../__tests__/test-database.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { accounts, users } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

const tokenFields = ["accessToken", "refreshToken", "idToken"] as const;
let connection: DatabaseConnection;
const userId = createId();
beforeAll(async () => {
  assertDisposableTestDatabase("account storage adapter proof");
  connection = createDatabase(testEnvironment());
  await connection.db.insert(users).values({
    id: userId,
    name: "Storage proof",
    email: `${userId}@example.com`,
  });
});
afterAll(async () => {
  await connection.db.delete(users).where(eq(users.id, userId));
  await connection.close();
});

test("supported account field transforms cover writes, reads, joins and transactions", async () => {
  const auth = createAuth(connection.db, testEnvironment());
  const { adapter } = await auth.$context;
  const tokens = {
    accessToken: "upstream-access-proof",
    refreshToken: "upstream-refresh-proof",
    idToken: "upstream-id-proof",
  };
  const row = await adapter.create({
    model: "account",
    data: {
      userId,
      providerId: "storage-proof",
      issuer: "https://storage.example.com",
      accountId: createId(),
      ...tokens,
    },
  });
  expect(row).toMatchObject(tokens);

  const assertStored = async (expected: typeof tokens) => {
    const [stored] = await connection.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, row.id));
    for (const field of tokenFields) {
      expect(stored![field]).not.toBe(expected[field]);
      expect(stored![field]).toStartWith("$ba$1$");
    }
    expect(
      await adapter.findOne({
        model: "account",
        where: [{ field: "id", value: row.id }],
      }),
    ).toMatchObject(expected);
  };
  await assertStored(tokens);
  const imported = await adapter.transaction(async (tx) =>
    tx.create({
      model: "account",
      data: {
        userId,
        providerId: "import-proof",
        issuer: "https://storage.example.com",
        accountId: createId(),
        accessToken: null,
        refreshToken: null,
        idToken: null,
      },
    }),
  );
  const [empty] = await connection.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, imported.id));
  expect(empty).toMatchObject({
    accessToken: null,
    refreshToken: null,
    idToken: null,
  });
  expect(
    await adapter.findOne({
      model: "account",
      where: [{ field: "id", value: imported.id }],
    }),
  ).toMatchObject({ accessToken: null, refreshToken: null, idToken: null });
  await adapter.delete({
    model: "account",
    where: [{ field: "id", value: imported.id }],
  });
  expect(
    await adapter.findOne({
      model: "account",
      where: [{ field: "id", value: row.id }],
    }),
  ).toMatchObject(tokens);
  expect(
    await adapter.findMany({
      model: "account",
      where: [{ field: "userId", value: userId }],
    }),
  ).toEqual([expect.objectContaining(tokens)]);
  expect(
    await adapter.findOne({
      model: "account",
      where: [{ field: "id", value: row.id }],
      select: ["idToken"],
    }),
  ).toMatchObject({ idToken: tokens.idToken });
  const joined = await adapter.findOne<{ account: unknown[] }>({
    model: "user",
    where: [{ field: "id", value: userId }],
    join: { account: true },
  });
  expect(joined?.account).toEqual([expect.objectContaining(tokens)]);

  const updated = { ...tokens, accessToken: "updated-access-proof" };
  expect(
    await adapter.update({
      model: "account",
      where: [{ field: "id", value: row.id }],
      update: { accessToken: updated.accessToken },
    }),
  ).toMatchObject(updated);
  await assertStored(updated);
  const final = {
    accessToken: "transaction-access-proof",
    refreshToken: "transaction-refresh-proof",
    idToken: "transaction-id-proof",
  };
  await adapter.transaction(async (tx) => {
    expect(
      await tx.update({
        model: "account",
        where: [{ field: "id", value: row.id }],
        update: final,
      }),
    ).toMatchObject(final);
    expect(
      await tx.findOne({
        model: "account",
        where: [{ field: "id", value: row.id }],
      }),
    ).toMatchObject(final);
  });
  await assertStored(final);
  await expect(
    adapter.transaction(async (tx) => {
      await tx.update({
        model: "account",
        where: [{ field: "id", value: row.id }],
        update: tokens,
      });
      throw new Error("storage rollback proof");
    }),
  ).rejects.toThrow("storage rollback proof");
  await assertStored(final);
  await adapter.updateMany({
    model: "account",
    where: [{ field: "userId", value: userId }],
    update: tokens,
  });
  await assertStored(tokens);
  await connection.db
    .update(accounts)
    .set({ idToken: "00".repeat(40) })
    .where(eq(accounts.id, row.id));
  await expect(
    adapter.findOne({
      model: "account",
      where: [{ field: "id", value: row.id }],
    }),
  ).rejects.toThrow();
});

test("production account storage retains old keys through incremental rotation", async () => {
  const environment = testEnvironment();
  const old = environment.upstreamTokenSecrets!;
  const current = {
    version: 2,
    value: Buffer.alloc(32, 29).toString("base64url"),
  };
  const tokens = {
    accessToken: "rotate-access",
    refreshToken: "rotate-refresh",
    idToken: "rotate-id",
  };
  const first = await createAuth(connection.db, environment).$context;
  const row = await first.adapter.create({
    model: "account",
    data: {
      userId,
      issuer: "https://rotate.example.com",
      providerId: "rotate",
      accountId: createId(),
      ...tokens,
    },
  });
  const rotating = await createAuth(connection.db, {
    ...environment,
    upstreamTokenSecrets: [current, ...old],
  }).$context;
  const where = [{ field: "id", value: row.id }];
  expect(
    await rotating.adapter.findOne({ model: "account", where }),
  ).toMatchObject(tokens);
  await rotating.adapter.update({
    model: "account",
    where,
    update: { idToken: tokens.idToken },
  });
  const [stored] = await connection.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, row.id));
  expect(stored!.accessToken).toStartWith("$ba$1$");
  expect(stored!.refreshToken).toStartWith("$ba$1$");
  expect(stored!.idToken).toStartWith("$ba$2$");
  const retired = await createAuth(connection.db, {
    ...environment,
    upstreamTokenSecrets: [current],
  }).$context;
  await expect(
    retired.adapter.findOne({ model: "account", where }),
  ).rejects.toThrow("Upstream token storage is unavailable");
  await rotating.adapter.update({ model: "account", where, update: tokens });
  expect(
    await retired.adapter.findOne({ model: "account", where }),
  ).toMatchObject(tokens);
});
