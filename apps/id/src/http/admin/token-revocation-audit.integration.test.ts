import { expectReceipt } from "../../__tests__/operation-receipt.ts";
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
import {
  adminOperations,
  auditEvents,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthClients,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";

let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_token_manifest_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = { ...fixture.environment, databaseUrl: url.toString() };
  runtime = createDatabase(environment);
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, environment),
    environment,
  });
});
afterEach(async () => {
  await runtime?.close();
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});
function request(
  path: string,
  method = "GET",
  key = createId(),
  kind: "platformAdmin" | "platformReader" | "tenantReader" = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  headers.set("Idempotency-Key", key);
  return app.request(`/api/admin/v1${path}`, { method, headers });
}
const sorted = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));
for (const mode of ["user", "session", "all", "client", "rotate"] as const) {
  test(`restricted ${mode} revocation retains exact safe token effects, rolls back subject failure and replays after erasure`, async () => {
    const db = fixture.db;
    const ids = [createId(), createId()];
    for (const id of ids)
      await db.insert(users).values({
        id,
        name: "Private name",
        email: `${id}@private.example`,
        status: "active",
      });
    const sessionId = createId();
    await db.insert(sessions).values({
      id: sessionId,
      userId: ids[0]!,
      token: createId(),
      expiresAt: new Date(Date.now() + 60000),
    });
    const clientId = createId();
    await db.insert(oauthClients).values({
      id: createId(),
      clientId,
      organizationId: fixture.tenant.organizationId,
      redirectUris: [],
      tokenEndpointAuthMethod: "client_secret_basic",
      clientSecret: "private-old-digest",
    });
    const secrets: string[] = [];
    for (const table of [oauthAccessTokens, oauthRefreshTokens]) {
      for (const userId of ids)
        for (const revoked of [null, new Date("2020-01-01")]) {
          const token = createId();
          secrets.push(token);
          await db.insert(table).values({
            id: createId(),
            clientId,
            userId,
            sessionId: userId === ids[0] ? sessionId : null,
            token,
            scopes: ["private:scope"],
            revoked,
            expiresAt: new Date(Date.now() + 60000),
          });
        }
    }
    await db.insert(oauthAccessTokens).values({
      id: createId(),
      clientId,
      scopes: [],
      expiresAt: new Date(Date.now() + 60000),
    });
    const snapshot = async () => ({
      access: sorted(await db.select().from(oauthAccessTokens)),
      refresh: sorted(await db.select().from(oauthRefreshTokens)),
      sessions: sorted(await db.select().from(sessions)),
      users: sorted(await db.select().from(users)),
      clients: sorted(await db.select().from(oauthClients)),
      operations: sorted(await db.select().from(adminOperations)),
      events: sorted(await db.select().from(auditEvents)),
    });
    const before = await snapshot();
    const clientWide = mode === "client" || mode === "rotate";
    const affected = (row: {
      clientId: string;
      userId: string | null;
      revoked: Date | null;
    }) =>
      row.clientId === clientId &&
      row.revoked === null &&
      (clientWide || row.userId === ids[0]);
    const refs = (rows: typeof before.access | typeof before.refresh) =>
      sorted(rows.filter(affected).map(({ id, userId }) => ({ id, userId })));
    const expected = {
      access: refs(before.access),
      refresh: refs(before.refresh),
    };
    const path = clientWide
      ? `/clients/${clientId}/${mode === "rotate" ? "rotate-secret" : "disable"}`
      : `/users/${ids[0]}${mode === "user" ? "/disable" : `/sessions${mode === "session" ? `/${sessionId}` : ""}`}`;
    const method = clientWide || mode === "user" ? "POST" : "DELETE";
    const key = createId();
    await db.execute(
      sql.raw(
        `alter table audit_event_subjects add constraint token_manifest_fault check (entity_id <> '${ids[0]!}') not valid`,
      ),
    );
    try {
      expect((await request(path, method, key)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.execute(
        sql`alter table audit_event_subjects drop constraint token_manifest_fault`,
      );
    }
    const applied = await request(path, method, key);
    expect(applied.status).toBe(mode === "session" ? 204 : 200);
    await applied.text();
    const operationId = applied.headers.get("Operation-Id")!;
    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId));
    expect(events).toHaveLength(clientWide ? 2 : 1);
    const effect = events.find(
      (row) => !clientWide || row.action === "client.grants_revoked",
    )!;
    expect(effect.schemaVersion).toBe(2);
    expect(effect.organizationId).toBeNull();
    const actual = effect.data!.revokedTokens as typeof expected;
    expect({
      access: sorted(actual.access),
      refresh: sorted(actual.refresh),
    }).toEqual(expected);
    for (const secret of [
      ...secrets,
      "private:scope",
      "private-old-digest",
      "Private name",
    ])
      expect(JSON.stringify(events)).not.toContain(secret);
    const after = await snapshot();
    for (const name of ["access", "refresh"] as const)
      for (const row of before[name]) {
        const stored = after[name].find((item) => item.id === row.id)!;
        if (affected(row)) expect(stored.revoked).toBeInstanceOf(Date);
        else expect(stored.revoked).toEqual(row.revoked);
      }
    if (clientWide) {
      const owner = await request(
        `/organizations/${fixture.tenant.organizationId}/audit-events?targetId=${clientId}`,
        "GET",
        createId(),
        "tenantReader",
      );
      expect(owner.status).toBe(200);
      const body = await owner.text();
      expect(body).toContain(effect.id);
      for (const row of [...expected.access, ...expected.refresh])
        expect(body).not.toContain(row.id);
      for (const id of ids) expect(body).not.toContain(id);
      expect(body).not.toContain("revokedTokens");
    }
    // History must survive live identity/token deletion without a provenance lookup.
    for (const id of clientWide ? ids : [ids[0]!])
      await db.delete(users).where(eq(users.id, id));
    const history = await request(
      `/users/${clientWide ? ids[1] : ids[0]}/audit-events`,
      "GET",
      createId(),
      "platformReader",
    );
    expect(history.status).toBe(200);
    expect(
      (await history.json()).items.some(
        (row: { id: string }) => row.id === effect.id,
      ),
    ).toBe(true);
    const replay = await request(path, method, key);
    expect(replay.status).toBe(applied.status);
    await expectReceipt(fixture.db, replay);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.headers.get("Operation-Id")).toBe(operationId);
    expect(
      await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, operationId)),
    ).toEqual(events);
  });
}
