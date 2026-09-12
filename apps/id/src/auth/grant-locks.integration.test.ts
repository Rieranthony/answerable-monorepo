import { updateCapability } from "../services/capabilities.ts";
import { organizationCapabilities } from "../db/schema/index.ts";
import { approveMachineCapability } from "../__tests__/capabilities.ts";
import { platformWriteService } from "../__tests__/platform-context.ts";
import { inPlatformWrite } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { getCurrentAdapter } from "better-auth";
import { createApp } from "../app.ts";
import { createId } from "../lib/id.ts";
import type { OAuthProviderExtension } from "@better-auth/oauth-provider";
import { decodeJwt } from "jose";
import * as resourcesImplementation from "../services/resources.ts";
const resources = {
  ...resourcesImplementation,
  updateResource: platformWriteService(resourcesImplementation.updateResource),
};
import { eq, sql } from "drizzle-orm";
import { createAuth } from "../auth.ts";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import {
  oauthAccessTokens,
  oauthClients,
  oauthResources,
  organizations,
  verifications,
} from "../db/schema/index.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createResource } from "../__tests__/resource-queries.ts";
import * as clientsImplementation from "../services/clients.ts";
const clients = {
  ...clientsImplementation,
  createClient: platformWriteService(clientsImplementation.createClient),
  updateClient: platformWriteService(clientsImplementation.updateClient),
  disableClient: platformWriteService(clientsImplementation.disableClient),
  enableClient: platformWriteService(clientsImplementation.enableClient),
  linkResource: platformWriteService(clientsImplementation.linkResource),
  unlinkResource: platformWriteService(clientsImplementation.unlinkResource),
};
import * as tenants from "../services/organizations.ts";
import { authTransaction } from "./database-adapter.ts";
import type { machineOAuthProvider } from "./machine-provider.ts";

let connection: DatabaseConnection;
const environment = testEnvironment({ databasePoolMax: 4 });
const actor = {
  actorType: "system" as const,
  actorId: "lock-proof",
  requestId: "lock-proof",
};
let tenantId: string;
let client: Awaited<ReturnType<typeof clients.createClient>>;
beforeAll(() => {
  connection = createDatabase(environment);
});
afterAll(async () => connection.close());
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate audit_events, organizations, oauth_clients, oauth_resources, verifications cascade`,
  );
  tenantId = (
    await createOrganization(connection.db, { slug: "locks", name: "Locks" })
  ).id;
  await createResource(connection.db, {
    identifier: environment.adminResourceIdentifier,
    name: "Admin",
    allowedScopes: ["org:read"],
    accessTokenTtl: 120,
  });
  client = await clients.createClient(connection.db, actor, {
    clientId: "lock-proof",
    name: "Proof",
    organizationId: tenantId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    redirectUris: [],
    clientCredentialsScopes: ["org:read"],
  });
  await clients.linkResource(
    connection.db,
    actor,
    client.clientId,
    environment.adminResourceIdentifier,
  );
  await approveMachineCapability(connection.db, {
    organizationId: tenantId,
    clientId: client.clientId,
    resource: environment.adminResourceIdentifier,
    scopes: ["org:read"],
  });
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function pausedAuth(
  position: "before" | "after",
  corruptInstance = false,
) {
  const entered = gate();
  const resume = gate();
  const auth = createAuth(connection.db, environment);
  const provider = auth.options.plugins.find(
    (p) => p.id === "oauth-provider",
  ) as ReturnType<typeof machineOAuthProvider>;
  const marker = createId();
  let pid = 0;
  let bound: object | undefined;
  const hold = async (
    adapter: object & Pick<Awaited<typeof auth.$context>["adapter"], "create">,
  ) => {
    bound = adapter;
    const result = await authTransaction(adapter).execute(
      sql`select pg_backend_pid() as pid`,
    );
    pid = Number(result.rows[0]!.pid);
    await adapter.create({
      model: "verification",
      data: {
        identifier: marker,
        value: "transaction-proof",
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    entered.release();
    await resume.promise;
  };
  if (position === "before") {
    const context = await auth.$context;
    const transaction = context.adapter.transaction.bind(context.adapter);
    context.adapter.transaction = (run) =>
      transaction(async (adapter) => {
        await hold(adapter);
        return run(adapter);
      });
  } else {
    const extension: OAuthProviderExtension = {
      claims: {
        accessToken: async ({ ctx }) => {
          await hold(await getCurrentAdapter(ctx.context.adapter));
          return {};
        },
      },
    };
    provider.options.extensions!.push(extension);
  }
  if (corruptInstance)
    provider.options.extensions!.unshift({
      claims: {
        accessToken: ({ client }) => {
          Object.assign(client, { id: createId() });
          return {};
        },
      },
    });
  return {
    auth,
    entered,
    resume,
    marker,
    pid: () => pid,
    adapter: () => bound!,
  };
}
function mint(auth: ReturnType<typeof createAuth>) {
  return auth.handler(
    new Request(`${environment.betterAuthUrl}/auth/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource: environment.adminResourceIdentifier,
        scope: "org:read",
      }),
    }),
  );
}
async function waitForBlockedWriter(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await connection.db.execute(
      sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
    );
    if (result.rows.length) return;
    await Bun.sleep(10);
  }
  throw new Error("Lifecycle writer did not wait on the issuing transaction");
}
for (const target of ["organization", "client"] as const) {
  test(`issuance commits before ${target} disable; its JWT stays invalid after re-enable`, async () => {
    const pause = await pausedAuth("after");
    const issued = mint(pause.auth);
    await pause.entered.promise;
    const disabled =
      target === "organization"
        ? inPlatformWrite(connection.db, (context) =>
            tenants.disableOrganization(context, tenantId),
          )
        : clients.disableClient(connection.db, actor, client.clientId);
    try {
      await waitForBlockedWriter(pause.pid());
    } finally {
      pause.resume.release();
      await issued;
    }
    const response = await issued;
    expect(response.status).toBe(200);
    const token = (await response.json()).access_token;

    await disabled;
    // JWT access tokens are not persisted by this provider. Invalidate their epoch.
    expect(await connection.db.select().from(oauthAccessTokens)).toHaveLength(
      0,
    );
    expect(
      await connection.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, pause.marker)),
    ).toHaveLength(1);
    if (target === "organization")
      await inPlatformWrite(connection.db, (context) =>
        tenants.enableOrganization(context, tenantId),
      );
    else await clients.enableClient(connection.db, actor, client.clientId);
    const app = createApp({ db: connection.db, auth: pause.auth, environment });
    expect(
      (
        await app.request("/api/admin/v1/me", {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    expect(() => authTransaction(pause.adapter())).toThrow(
      "active authentication transaction",
    );
  });
  test(`${target} disable commits before identity checks and denies issuance`, async () => {
    const pause = await pausedAuth("before");
    const issued = mint(pause.auth);
    await pause.entered.promise;
    try {
      if (target === "organization")
        await inPlatformWrite(connection.db, (context) =>
          tenants.disableOrganization(context, tenantId),
        );
      else await clients.disableClient(connection.db, actor, client.clientId);
    } finally {
      pause.resume.release();
      await issued;
    }
    expect((await issued).status).toBe(401);
    expect(
      await connection.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, pause.marker)),
    ).toHaveLength(0);
    expect(await connection.db.select().from(oauthAccessTokens)).toHaveLength(
      0,
    );
    expect(() => authTransaction(pause.adapter())).toThrow(
      "active authentication transaction",
    );
  });
}

test("two issuances share the organisation lock; another tenant can change", async () => {
  const first = await pausedAuth("after");
  const second = await pausedAuth("after");
  const requests = [mint(first.auth), mint(second.auth)];
  try {
    await Promise.all([first.entered.promise, second.entered.promise]);
    const other = await createOrganization(connection.db, {
      slug: "other",
      name: "Other",
    });
    await inPlatformWrite(connection.db, (context) =>
      tenants.disableOrganization(context, other.id),
    );
    expect(
      (
        await connection.db
          .select()
          .from(organizations)
          .where(eq(organizations.id, tenantId))
      )[0]!.status,
    ).toBe("active");
  } finally {
    first.resume.release();
    second.resume.release();
  }
  expect(
    (await Promise.all(requests)).map((response) => response.status),
  ).toEqual([200, 200]);
});

test("locked current client must match the authenticated instance", async () => {
  const pause = await pausedAuth("before", true);
  const issued = mint(pause.auth);
  await pause.entered.promise;
  pause.resume.release();
  expect((await issued).status).toBe(401);
  expect(
    await connection.db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, pause.marker)),
  ).toHaveLength(0);
});

test("a blocked issuance times out, rolls back and can retry without leaking pool settings", async () => {
  const baseline = await connection.pool.query("show lock_timeout");
  const locked = gate();
  const release = gate();
  const writer = connection.db.transaction(async (tx) => {
    await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, tenantId))
      .for("update");
    locked.release();
    await release.promise;
  });
  await locked.promise;
  const pause = await pausedAuth("before");
  const issued = mint(pause.auth);
  try {
    await pause.entered.promise;
    pause.resume.release();
    const response = await issued;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({
      error: "temporarily_unavailable",
      error_description:
        "Authorization state is busy. Retry the token request.",
    });
    expect(
      await connection.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, pause.marker)),
    ).toHaveLength(0);
    expect(() => authTransaction(pause.adapter())).toThrow(
      "active authentication transaction",
    );
  } finally {
    pause.resume.release();
    release.release();
    await writer;
  }
  expect((await mint(pause.auth)).status).toBe(200);
  expect(
    await connection.db
      .select()
      .from(verifications)
      .where(eq(verifications.identifier, pause.marker)),
  ).toHaveLength(1);
  const pooled = await Promise.all(
    Array.from({ length: 4 }, () => connection.pool.connect()),
  );
  try {
    const settings = await Promise.all(
      pooled.map((client) => client.query("show lock_timeout")),
    );
    expect(settings.map((result) => result.rows[0].lock_timeout)).toEqual(
      Array(4).fill(baseline.rows[0].lock_timeout),
    );
  } finally {
    for (const client of pooled) client.release();
  }
});

for (const policy of ["resource", "client", "grant", "capability"] as const) {
  test(`committed ${policy} policy changes are read after authentication`, async () => {
    const pause = await pausedAuth("before");
    const issued = mint(pause.auth);
    await pause.entered.promise;
    try {
      if (policy === "resource")
        await resources.updateResource(
          connection.db,
          actor,
          environment.adminResourceIdentifier,
          { allowedScopes: [] },
        );
      else if (policy === "client")
        await clients.updateClient(connection.db, actor, client.clientId, {
          clientCredentialsScopes: ["org:write"],
        });
      else if (policy === "capability") {
        const [capability] = await connection.db
          .select()
          .from(organizationCapabilities);
        await inPlatformWrite(connection.db, (context) =>
          updateCapability(
            context,
            tenantId,
            capability!.id,
            { status: "disabled" },
            capability!,
          ),
        );
      } else
        await connection.db
          .update(oauthClients)
          .set({ grantTypes: [] })
          .where(eq(oauthClients.clientId, client.clientId));
    } finally {
      pause.resume.release();
      await issued;
    }
    const response = await issued;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error:
        policy === "grant" || policy === "capability"
          ? "unauthorized_client"
          : "invalid_scope",
    });
    expect(
      await connection.db
        .select()
        .from(verifications)
        .where(eq(verifications.identifier, pause.marker)),
    ).toHaveLength(0);
  });
}

test("resource scope and lifetime changes wait for issuance; later tokens use current policy", async () => {
  const old = (
    await connection.db
      .select()
      .from(oauthResources)
      .where(eq(oauthResources.identifier, environment.adminResourceIdentifier))
  )[0]!;
  const pause = await pausedAuth("after");
  const issued = mint(pause.auth);
  await pause.entered.promise;
  const changed = resources.updateResource(
    connection.db,
    actor,
    environment.adminResourceIdentifier,
    { allowedScopes: [], accessTokenTtl: 30 },
  );
  try {
    await waitForBlockedWriter(pause.pid());
  } finally {
    pause.resume.release();
  }
  const response = await issued;
  expect(response.status).toBe(200);
  const token = decodeJwt((await response.json()).access_token);
  expect(token.exp! - token.iat!).toBe(old.accessTokenTtl!);
  await changed;
  expect((await mint(pause.auth)).status).toBe(400);
  await resources.updateResource(
    connection.db,
    actor,
    environment.adminResourceIdentifier,
    { allowedScopes: ["org:read"] },
  );
  const fresh = await mint(pause.auth);
  expect(fresh.status).toBe(200);
  const freshToken = decodeJwt((await fresh.json()).access_token);
  expect(freshToken.exp! - freshToken.iat!).toBe(30);
});

test("resource unlink waits for issuance and denies subsequent tokens", async () => {
  const pause = await pausedAuth("after");
  const issued = mint(pause.auth);
  await pause.entered.promise;
  const unlinked = clients.unlinkResource(
    connection.db,
    actor,
    client.clientId,
    environment.adminResourceIdentifier,
  );
  try {
    await waitForBlockedWriter(pause.pid());
  } finally {
    pause.resume.release();
  }
  expect((await issued).status).toBe(200);
  await unlinked;
  const response = await mint(pause.auth);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_target" });
});

test("capability revocation waits for issuance and then denies subsequent grants", async () => {
  const [capability] = await connection.db
    .select()
    .from(organizationCapabilities);
  const pause = await pausedAuth("after");
  const issued = mint(pause.auth);
  await pause.entered.promise;
  const writer = inPlatformWrite(connection.db, (context) =>
    updateCapability(
      context,
      tenantId,
      capability!.id,
      { status: "disabled" },
      capability!,
    ),
  );
  try {
    await waitForBlockedWriter(pause.pid());
  } finally {
    pause.resume.release();
  }
  expect((await issued).status).toBe(200);
  expect((await writer).row.status).toBe("disabled");
  const denied = await mint(pause.auth);
  expect(denied.status).toBe(400);
  expect(await denied.json()).toMatchObject({ error: "unauthorized_client" });
});

test("a capability that expires after the issuance transaction starts is denied at policy evaluation", async () => {
  const pause = await pausedAuth("before");
  const issued = mint(pause.auth);
  await pause.entered.promise;
  try {
    // The active issuance transaction predates this expiry instant; no sleep or guessed delay.
    await connection.db
      .update(organizationCapabilities)
      .set({ validUntil: sql`clock_timestamp()` });
  } finally {
    pause.resume.release();
  }
  const response = await issued;
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "unauthorized_client" });
});
