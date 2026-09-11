import { expectReceipt } from "../__tests__/operation-receipt.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { createDatabase, type DatabaseConnection } from "./client.ts";
import { configureRuntimeRole } from "./runtime-role.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { adminOperations, auditEvents, organizations } from "./schema/index.ts";
let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
const role = `id_test_deadline_${crypto.randomUUID().replaceAll("-", "")}`;
beforeAll(async () => {
  fixture = await createAdminFixture();
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = {
    ...fixture.environment,
    databaseUrl: url.toString(),
    databaseStatementTimeoutMs: 500,
    databaseLockTimeoutMs: 100,
    databaseIdleInTransactionTimeoutMs: 1500,
  };
  runtime = createDatabase(environment);
  app = createApp({
    auth: createAuth(runtime.db, environment),
    db: runtime.db,
    environment,
  });
});
afterAll(async () => {
  await runtime?.close();
  if (fixture) {
    await fixture.db.execute(
      sql`drop trigger if exists test_statement_pause on admin_operations`,
    );
    await fixture.db.execute(
      sql`drop function if exists test_statement_pause()`,
    );
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});
test("runtime connection applies a server-side statement deadline and remains usable after cancellation", async () => {
  expect(
    (await runtime.pool.query("show lock_timeout")).rows[0].lock_timeout,
  ).toBe("100ms");
  expect(
    (await runtime.pool.query("show idle_in_transaction_session_timeout"))
      .rows[0].idle_in_transaction_session_timeout,
  ).toBe("1500ms");
  expect(
    (await runtime.pool.query("show statement_timeout")).rows[0]
      .statement_timeout,
  ).toBe("500ms");
  await expect(runtime.pool.query("select pg_sleep(5)")).rejects.toMatchObject({
    code: "57014",
  });
  expect((await runtime.pool.query("select 1 as healthy")).rows).toEqual([
    { healthy: 1 },
  ]);
  expect(
    (await runtime.pool.query("show statement_timeout")).rows[0]
      .statement_timeout,
  ).toBe("500ms");
});
test("timed-out command rolls back domain, audit and receipt and retries the same key", async () => {
  const key = crypto.randomUUID();
  const slug = `deadline-${key}`;
  const operationsBefore = await fixture.db.select().from(adminOperations);
  const events = () =>
    fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "organization.created"));
  const before = await events();
  await fixture.db.execute(
    sql`create function test_statement_pause() returns trigger language plpgsql as $$ begin perform pg_sleep(5); return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger test_statement_pause before insert on admin_operations for each row execute function test_statement_pause()`,
  );
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  headers.set("Content-Type", "application/json");
  const request = () =>
    app.request("/api/admin/v1/organizations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug,
        name: "Deadline",
      }),
    });
  try {
    const failed = await request();
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Retry-After")).toBe("1");
    expect(await failed.json()).toMatchObject({
      code: "database_busy",
      retryable: true,
    });
    expect(
      await fixture.db
        .select()
        .from(organizations)
        .where(eq(organizations.slug, slug)),
    ).toHaveLength(0);
    expect(await fixture.db.select().from(adminOperations)).toEqual(
      operationsBefore,
    );
    expect(await events()).toEqual(before);
  } finally {
    await fixture.db.execute(
      sql`drop trigger test_statement_pause on admin_operations`,
    );
    await fixture.db.execute(sql`drop function test_statement_pause()`);
  }
  const committed = await request();
  expect(committed.status).toBe(201);
  await committed.json();
  const replayed = await request();
  expect(replayed.status).toBe(201);
  expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
  await expectReceipt(fixture.db, replayed);
  expect(await events()).toHaveLength(before.length + 1);
  expect(await fixture.db.select().from(adminOperations)).toHaveLength(
    operationsBefore.length + 1,
  );
});
test("pool lock timeout returns 55P03 and a retryable machine response without issuing a token", async () => {
  const blocker = createDatabase(fixture.environment);
  const lock = await blocker.pool.connect();
  const mint = () =>
    app.request("/auth/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${fixture.platform.client.clientId}:${fixture.platform.client.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource: fixture.platform.adminResource,
        scope: "platform:read",
      }),
    });
  const issued = () =>
    fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "oauth.token.issued"));
  const before = await issued();
  try {
    await lock.query("begin");
    await lock.query("select id from organizations where id = $1 for update", [
      fixture.platform.organizationId,
    ]);
    await expect(
      runtime.pool.query(
        "select id from organizations where id = $1 for share",
        [fixture.platform.organizationId],
      ),
    ).rejects.toMatchObject({ code: "55P03" });
    const denied = await mint();
    expect(denied.status).toBe(503);
    expect(denied.headers.get("Retry-After")).toBe("1");
    expect(await denied.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
    expect(await issued()).toEqual(before);
  } finally {
    await lock.query("rollback");
    lock.release();
    await blocker.close();
  }
  const recovered = await mint();
  expect(recovered.status).toBe(200);
  expect((await recovered.json()).access_token).toBeString();
});
