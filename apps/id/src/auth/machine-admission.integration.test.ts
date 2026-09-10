import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { createAdminFixture, type AdminFixture } from "../__tests__/admin.ts";
import { approveMachineCapability } from "../__tests__/capabilities.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import { auditEvents } from "../db/schema/index.ts";
import * as clients from "../services/clients.ts";
import type { machineOAuthProvider } from "./machine-provider.ts";

let fixture: AdminFixture;
const connections: DatabaseConnection[] = [];
const role = `id_test_capacity_${crypto.randomUUID().replaceAll("-", "")}`;
let databaseUrl: string;
type Client = { clientId: string; secret: string };
let sameTenant: Client;
let otherTenant: Client;
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
  databaseUrl = url.toString();
  async function client(organizationId: string): Promise<Client> {
    const created = await platformWriteService(clients.createClient)(
      fixture.db,
      {
        requestId: "capacity-proof",
      },
      {
        clientId: crypto.randomUUID(),
        name: "Capacity proof",
        organizationId,
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        redirectUris: [],
        clientCredentialsScopes: ["org:read"],
      },
    );
    await platformWriteService(clients.linkResource)(
      fixture.db,
      {
        requestId: "capacity-proof",
      },
      created.clientId,
      fixture.platform.adminResource,
    );
    await approveMachineCapability(fixture.db, {
      organizationId,
      clientId: created.clientId,
      resource: fixture.platform.adminResource,
      scopes: ["org:read"],
    });
    return { clientId: created.clientId, secret: created.clientSecret! };
  }
  sameTenant = await client(fixture.platform.organizationId);
  otherTenant = await client(fixture.tenant.organizationId);
});
afterAll(async () => {
  await Promise.all(connections.map((connection) => connection.close()));
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});
function replica(pause?: {
  entered: () => void;
  resume: Promise<void>;
  fail: boolean;
}) {
  const environment = { ...fixture.environment, databaseUrl };
  const connection = createDatabase(environment);
  connections.push(connection);
  const auth = createAuth(connection.db, environment);
  if (pause) {
    const provider = auth.options.plugins.find(
      (plugin) => plugin.id === "oauth-provider",
    ) as ReturnType<typeof machineOAuthProvider>;
    provider.options.extensions!.push({
      claims: {
        accessToken: async () => {
          pause.entered();
          await pause.resume;
          if (pause.fail)
            throw new APIError("BAD_REQUEST", { error: "invalid_scope" });
          return {};
        },
      },
    });
  }
  return createApp({ db: connection.db, environment, auth });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function mint(
  app: ReturnType<typeof replica>,
  client: Client,
  forgedTenant?: string,
) {
  return app.request("/auth/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "x-tenant-id": forgedTenant ?? "ignored",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: fixture.platform.adminResource,
      scope:
        client.clientId === fixture.platform.client.clientId
          ? "platform:read"
          : "org:read",
      organization_id: forgedTenant ?? "ignored",
    }),
  });
}
for (const fail of [false, true]) {
  test(`shared tenant issuance slots survive independent pools and release after ${fail ? "rollback" : "commit"}`, async () => {
    const entered = [gate(), gate()];
    const resume = gate();
    const first = replica({
      entered: entered[0]!.release,
      resume: resume.promise,
      fail,
    });
    const second = replica({
      entered: entered[1]!.release,
      resume: resume.promise,
      fail,
    });
    const third = replica();
    const pending = [
      mint(first, fixture.platform.client),
      mint(second, sameTenant),
    ];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(entered.map((gate) => gate.promise)),
        new Promise(
          (_, reject) =>
            (timeout = setTimeout(
              () => reject(new Error("Issuances did not reach signing")),
              5000,
            )),
        ),
      ]);
      clearTimeout(timeout);
      const before = await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "oauth.token.issued"));
      const busy = await mint(third, sameTenant, fixture.tenant.organizationId);
      expect(busy.status).toBe(503);
      expect(busy.headers.get("Retry-After")).toBe("1");
      expect(await busy.json()).toMatchObject({
        error: "temporarily_unavailable",
      });
      expect(
        await fixture.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "oauth.token.issued")),
      ).toEqual(before);
      const rejected = await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.requestId, busy.headers.get("x-request-id")!));
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        organizationId: fixture.platform.organizationId,
        actorId: sameTenant.clientId,
        reason: "temporarily_unavailable",
      });
      expect((await mint(third, otherTenant)).status).toBe(200);
    } finally {
      clearTimeout(timeout);
      resume.release();
      await Promise.all(pending);
    }
    expect(
      (await Promise.all(pending)).map((response) => response.status),
    ).toEqual(fail ? [400, 400] : [200, 200]);
    const retained = await fixture.db.execute(sql`select pid from pg_locks
      where locktype = 'advisory' and ((classid::bigint << 32) | objid::bigint) in (
        hashtextextended(${`machine-issuance:${fixture.platform.organizationId}:0`}, 0),
        hashtextextended(${`machine-issuance:${fixture.platform.organizationId}:1`}, 0)
      )`);
    expect(retained.rows).toHaveLength(0);
    expect((await mint(third, sameTenant)).status).toBe(200);
    expect((await mint(third, fixture.platform.client)).status).toBe(200);
  });
}
