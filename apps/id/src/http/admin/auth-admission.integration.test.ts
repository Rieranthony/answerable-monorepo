import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema/index.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import { auditEvents } from "../../db/schema/index.ts";
let fixture: AdminFixture;
let control: DatabaseConnection;
let role: string;
const runtimes: DatabaseConnection[] = [];
const apps: ReturnType<typeof createApp>[] = [];
beforeEach(async () => {
  fixture = await createAdminFixture();
  control = createDatabase(fixture.environment);
  role = `id_test_auth_load_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  for (let index = 0; index < 2; index++) {
    const url = new URL(fixture.environment.databaseUrl);
    url.username = role;
    url.password = password;
    const environment = {
      ...fixture.environment,
      databaseUrl: url.toString(),
      databasePoolMax: 4,
    };
    const runtime = createDatabase(environment);
    runtimes.push(runtime);
    const services = {
      db: runtime.db,
      auth: createAuth(runtime.db, environment),
      environment,
    };
    // Two app objects share each pool: the bound must follow the pool, not the router.
    const alias = drizzle(runtime.pool, { schema });
    apps.push(
      createApp(services),
      createApp({
        ...services,
        db: alias,
        auth: createAuth(alias, environment),
      }),
    );
  }
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  apps.splice(0);
  await control?.close();
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});

for (const poolCount of [1, 2]) {
  test(`unauthenticated rejection work preserves tenant reads across ${poolCount} pools and app aliases`, async () => {
    const gate = 742491;
    await fixture.db.execute(
      sql.raw(
        `create function pause_auth_rejection() returns trigger language plpgsql as $$ begin if NEW.action='oauth.token.rejected' then perform pg_advisory_xact_lock(${gate}); end if; return NEW; end $$`,
      ),
    );
    await fixture.db.execute(
      sql`create trigger pause_auth_rejection before insert on audit_events for each row execute function pause_auth_rejection()`,
    );
    const ready = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    let blockerPid = 0,
      settled = 0;
    const blocker = fixture.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${gate})`);
      blockerPid = Number(
        (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      ready.resolve();
      await resume.promise;
    });
    await ready.promise;
    const send = (index: number) =>
      apps[Math.floor(index / 4) * 2 + (index % 2)]!.request(
        "/auth/oauth2/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from("unknown-client:wrong-secret").toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            resource: fixture.environment.adminResourceIdentifier,
          }),
        },
      );
    const pending = Array.from({ length: poolCount * 4 }, (_, index) =>
      Promise.resolve(send(index)).then((response) => {
        settled++;
        return response;
      }),
    );
    try {
      let blockedCount = 0;
      const deadline = Date.now() + 1500;
      while (true) {
        const result = await control.db.execute(sql`with recursive waiting as (
          select pid from pg_stat_activity where usename=${role} and ${blockerPid}=any(pg_blocking_pids(pid))
          union select a.pid from pg_stat_activity a join waiting w on w.pid=any(pg_blocking_pids(a.pid)) where a.usename=${role}
        ) select count(*)::int as n from waiting`);
        blockedCount = Number(result.rows[0]!.n);
        if (blockedCount + settled === poolCount * 4) break;
        if (Date.now() > deadline)
          throw new Error(
            `Expected stable rejection work, saw ${blockedCount} blocked and ${settled} settled`,
          );
        await Bun.sleep(10);
      }
      expect(blockedCount).toBeGreaterThan(0);
      for (let index = 0; index < poolCount; index++)
        for (const reader of ["root", "outsider"] as const) {
          const response = await apps[index * 2]!.request(
            `/api/admin/v1/organizations/${fixture.outsider.organizationId}/groups`,
            { headers: fixture.headers(reader) },
          );
          expect(response.status).toBe(200);
        }
      expect(blockedCount).toBe(poolCount * 3);
      expect(settled).toBe(poolCount);
    } finally {
      resume.resolve();
      await blocker;
      await Promise.allSettled(pending);
      await fixture.db.execute(
        sql`drop trigger pause_auth_rejection on audit_events`,
      );
      await fixture.db.execute(sql`drop function pause_auth_rejection()`);
    }
    const responses = await Promise.all(pending);
    expect(responses.filter((row) => row.status === 401)).toHaveLength(
      poolCount * 3,
    );
    expect(responses.filter((row) => row.status === 503)).toHaveLength(
      poolCount,
    );
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "oauth.token.rejected"));
    expect(events).toHaveLength(poolCount * 3);
    for (const event of events)
      expect(event).toMatchObject({
        schemaVersion: 3,
        organizationId: null,
        targetId: null,
      });
    for (const [index, response] of responses.entries())
      if (response.status === 503) {
        expect(response.headers.get("Retry-After")).toBe("1");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.text()).toBe("Service Busy");
        expect((await send(index)).status).toBe(401);
      }
  });
}
