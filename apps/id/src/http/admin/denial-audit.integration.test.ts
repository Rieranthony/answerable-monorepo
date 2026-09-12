import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import {
  auditEvents,
  organizations,
  adminOperations,
} from "../../db/schema/index.ts";

let fixture: AdminFixture;
let runtime: DatabaseConnection;
let role: string;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_denial_audit_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  runtime = createDatabase({
    ...fixture.environment,
    databaseUrl: url.toString(),
    databasePoolMax: 2,
  });
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, fixture.environment),
    environment: fixture.environment,
  });
});
afterEach(async () => {
  await runtime?.close();
  await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
  await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
  await fixture.close();
});

for (const kind of ["scope", "foreign", "locked-root", "machine"] as const) {
  test(`audit outage preserves the existing ${kind} refusal and never invokes the protected handler`, async () => {
    const before = await fixture.db.select().from(organizations);
    if (kind === "locked-root") {
      const environment = {
        ...fixture.environment,
        rootAdminBreakGlass: false,
      };
      app = createApp({
        db: runtime.db,
        auth: createAuth(runtime.db, environment),
        environment,
      });
    }
    const path =
      kind === "foreign"
        ? `/api/admin/v1/organizations/${fixture.outsider.organizationId}/groups`
        : "/api/admin/v1/organizations";
    const headers = fixture.headers(
      kind === "machine"
        ? { bearer: await fixture.mintMachineToken(["platform:read"]) }
        : kind === "locked-root"
          ? "root"
          : "tenantAdmin",
    );
    headers.set("Content-Type", "application/json");
    const request = () =>
      app.request(path, {
        method: kind === "foreign" ? "GET" : "POST",
        headers,
        body:
          kind === "foreign"
            ? undefined
            : JSON.stringify({
                name: "Must not be created",
                slug: "must-not-be-created",
              }),
      });
    const baseline = await request();
    const expected = {
      status: baseline.status,
      body: await baseline.json(),
      challenge: baseline.headers.get("WWW-Authenticate"),
    };
    expect(expected.status).toBe(kind === "foreign" ? 404 : 403);
    expect(expected.body.code).toBe(
      kind === "foreign"
        ? "not_found"
        : kind === "locked-root"
          ? "root_locked"
          : "insufficient_scope",
    );
    if (kind === "machine")
      expect(expected.challenge).toBe('Bearer error="insufficient_scope"');
    const initialEvents = await fixture.db.select().from(auditEvents);
    await fixture.db.execute(
      sql`create function refuse_denial_audit() returns trigger language plpgsql as $$ begin if NEW.outcome = 'denied' then raise exception 'synthetic-secret-must-not-be-logged'; end if; return NEW; end $$`,
    );
    await fixture.db.execute(
      sql`create trigger refuse_denial_audit before insert on audit_events for each row execute function refuse_denial_audit()`,
    );
    const messages: unknown[][] = [];
    const logging = spyOn(console, "error").mockImplementation((...args) => {
      messages.push(args);
    });
    try {
      const response = await request();
      expect(response.status).toBe(expected.status);
      expect(await response.json()).toMatchObject({
        code: expected.body.code,
        title: expected.body.title,
      });
      expect(response.headers.get("WWW-Authenticate")).toBe(expected.challenge);
      expect(await fixture.db.select().from(organizations)).toEqual(before);
      expect(await fixture.db.select().from(auditEvents)).toEqual(
        initialEvents,
      );
      expect(messages).toEqual([
        [
          "[id] audit",
          JSON.stringify({
            event: "admin_denial_audit_unavailable",
            requestId: response.headers.get("x-request-id"),
          }),
        ],
      ]);
    } finally {
      logging.mockRestore();
      await fixture.db.execute(
        sql`drop trigger refuse_denial_audit on audit_events`,
      );
      await fixture.db.execute(sql`drop function refuse_denial_audit()`);
    }
    expect((await request()).status).toBe(expected.status);
    expect(await fixture.db.select().from(auditEvents)).toHaveLength(
      initialEvents.length + 1,
    );
  });
}

test("successful root admission still requires its audit and same-key recovery commits once", async () => {
  const before = await fixture.db.select().from(organizations);
  const operations = await fixture.db.select().from(adminOperations);
  const headers = fixture.headers("root");
  headers.set("Content-Type", "application/json");
  const request = () =>
    app.request("/api/admin/v1/organizations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Recovered",
        slug: "recovered-denial-proof",
      }),
    });
  await fixture.db.execute(
    sql`create function refuse_root_admission() returns trigger language plpgsql as $$ begin if NEW.action = 'admin.root_request' and NEW.outcome = 'success' then raise exception 'synthetic-root-admission-audit-outage'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger refuse_root_admission before insert on audit_events for each row execute function refuse_root_admission()`,
  );
  const logging = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await request()).status).toBe(500);
    expect(await fixture.db.select().from(organizations)).toEqual(before);
    expect(await fixture.db.select().from(adminOperations)).toEqual(operations);
  } finally {
    logging.mockRestore();
    await fixture.db.execute(
      sql`drop trigger refuse_root_admission on audit_events`,
    );
    await fixture.db.execute(sql`drop function refuse_root_admission()`);
  }
  const first = await request();
  expect(first.status).toBe(201);
  await first.json();
  const replay = await request();
  expect(replay.status).toBe(201);
  await expectReceipt(fixture.db, replay);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await fixture.db.select().from(organizations)).toHaveLength(
    before.length + 1,
  );
  expect(await fixture.db.select().from(adminOperations)).toHaveLength(
    operations.length + 1,
  );
});
