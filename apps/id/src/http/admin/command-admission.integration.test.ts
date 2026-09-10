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
import { adminOperations, auditEvents, groups } from "../../db/schema/index.ts";
let fixture: AdminFixture;
let control: DatabaseConnection;
let role: string;
const runtimes: DatabaseConnection[] = [];
const apps: ReturnType<typeof createApp>[] = [];
beforeEach(async () => {
  fixture = await createAdminFixture();
  control = createDatabase(fixture.environment);
  role = `id_test_command_load_${crypto.randomUUID().replaceAll("-", "")}`;
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
  test(`queued tenant commands preserve another tenant's reads across ${poolCount} runtime pools`, async () => {
    const organizationId = fixture.tenant.organizationId;
    const before = await fixture.db.select().from(adminOperations);
    let release!: () => void, entered!: () => void;
    let blockerPid = 0;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = fixture.db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from organizations where id = ${organizationId}::uuid for update`,
      );
      blockerPid = Number(
        (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
      );
      entered();
      await resume;
    });
    await ready;
    const requests = Array.from({ length: poolCount * 4 }, (_, index) => {
      const headers = fixture.headers("root");
      headers.set("Idempotency-Key", crypto.randomUUID());
      headers.set("Content-Type", "application/json");
      return {
        app: apps[Math.floor(index / 4) * 2 + (index % 2)]!,
        headers,
        body: JSON.stringify({
          slug: `capacity-${index}`,
          name: `Capacity ${index}`,
        }),
      };
    });
    const send = (request: (typeof requests)[number]) =>
      request.app.request(
        `/api/admin/v1/organizations/${organizationId}/groups`,
        { method: "POST", headers: request.headers, body: request.body },
      );
    let settled = 0;
    const pending = requests.map((request) =>
      Promise.resolve(send(request)).then((response) => {
        settled++;
        return response;
      }),
    );
    let blockedCount = 0;
    try {
      const deadline = Date.now() + 1_500;
      while (true) {
        const blocked = await control.db.execute(sql`
          with recursive waiting as (
            select pid from pg_stat_activity where usename = ${role} and ${blockerPid} = any(pg_blocking_pids(pid))
            union
            select a.pid from pg_stat_activity a join waiting w on w.pid = any(pg_blocking_pids(a.pid)) where a.usename = ${role}
          ) select count(*)::int as n from waiting`);
        blockedCount = Number(blocked.rows[0]!.n);
        if (
          blockedCount === poolCount * 4 ||
          (blockedCount === poolCount * 2 && settled === poolCount * 2)
        )
          break;
        if (Date.now() > deadline)
          throw new Error(
            `Expected blocked commands, saw ${blockedCount} and ${settled} settled`,
          );
        await Bun.sleep(10);
      }
      // The held lock remains in place during B's actual HTTP requests.
      for (let index = 0; index < poolCount; index++) {
        for (const reader of ["root", "outsider"] as const) {
          const response = await apps[index * 2]!.request(
            `/api/admin/v1/organizations/${fixture.outsider.organizationId}/groups`,
            { headers: fixture.headers(reader) },
          );
          expect(response.status).toBe(200);
        }
      }
      expect(blockedCount).toBe(poolCount * 2);
      // Casing cannot create another capacity bucket for the same UUID.
      const uppercase = await apps[0]!.request(
        `/api/admin/v1/organizations/${organizationId.toUpperCase()}/groups`,
        {
          method: "POST",
          headers: requests[0]!.headers,
          body: JSON.stringify({ slug: "uppercase", name: "Uppercase" }),
        },
      );
      expect(uppercase.status).toBe(503);
      const unauthorized = await apps[0]!.request(
        `/api/admin/v1/organizations/${organizationId}/groups`,
        {
          method: "POST",
          headers: fixture.headers("outsider"),
          body: "{}",
        },
      );
      expect(unauthorized.status).toBe(403);
    } finally {
      release();
      await blocker;
      await Promise.allSettled(pending);
    }
    const responses = await Promise.all(pending);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(
      poolCount * 2,
    );
    expect(responses.filter((r) => r.status === 503)).toHaveLength(
      poolCount * 2,
    );
    expect(await fixture.db.select().from(adminOperations)).toHaveLength(
      before.length + poolCount * 2,
    );
    for (const [index, response] of responses.entries()) {
      if (response.status !== 503) continue;
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(response.headers.get("Operation-Id")).toBeNull();
      expect(await response.json()).toMatchObject({
        code: "database_busy",
        retryable: true,
      });
      const retry = await send(requests[index]!);
      expect(retry.status).toBe(201);
      const replay = await send(requests[index]!);
      expect(replay.status).toBe(201);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await replay.json()).toEqual(await retry.json());
      expect(
        await fixture.db
          .select()
          .from(auditEvents)
          .where(
            eq(auditEvents.operationId, retry.headers.get("Operation-Id")!),
          ),
      ).toHaveLength(1);
    }
    expect(
      await fixture.db
        .select()
        .from(groups)
        .where(eq(groups.organizationId, organizationId)),
    ).toHaveLength(poolCount * 4);
  });
}

test("failed journal work releases command slots before same-key recovery and replay", async () => {
  const organizationId = fixture.tenant.organizationId;
  const before = await fixture.db.select().from(adminOperations);
  const requests = [0, 1].map((index) => {
    const headers = fixture.headers("root");
    headers.set("Idempotency-Key", crypto.randomUUID());
    headers.set("Content-Type", "application/json");
    return {
      headers,
      body: JSON.stringify({ slug: `rollback-${index}`, name: "Rollback" }),
    };
  });
  const send = (input: (typeof requests)[number]) =>
    apps[0]!.request(`/api/admin/v1/organizations/${organizationId}/groups`, {
      method: "POST",
      ...input,
    });
  await fixture.db.execute(
    sql`alter table audit_events add constraint command_admission_fault check (action <> 'group.created') not valid`,
  );
  try {
    const failed = await Promise.all(requests.map(send));
    expect(failed.map((response) => response.status)).toEqual([400, 400]);
  } finally {
    await fixture.db.execute(
      sql`alter table audit_events drop constraint command_admission_fault`,
    );
  }
  expect(
    await fixture.db
      .select()
      .from(groups)
      .where(eq(groups.organizationId, organizationId)),
  ).toEqual([]);
  expect(await fixture.db.select().from(adminOperations)).toEqual(before);
  const retried = await Promise.all(requests.map(send));
  expect(retried.map((response) => response.status)).toEqual([201, 201]);
  const replayed = await Promise.all(requests.map(send));
  for (const [index, response] of replayed.entries()) {
    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await response.json()).toEqual(await retried[index]!.json());
  }
  expect(await fixture.db.select().from(adminOperations)).toHaveLength(
    before.length + 2,
  );
});
