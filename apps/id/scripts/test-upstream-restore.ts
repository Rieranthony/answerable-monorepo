import { prepareRestoredSigning } from "../src/__tests__/restore-signing.ts";
import { prepareRestoredRetention } from "../src/__tests__/restore-retention.ts";
import { prepareRestoredRuntime } from "../src/__tests__/restore-runtime.ts";
import { restoreCluster } from "../src/__tests__/restore-cluster.ts";
import { prepareRestoredCommands } from "../src/__tests__/restore-commands.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client.ts";
import { createAuth } from "../src/auth.ts";
import { createApp } from "../src/app.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  assertRuntimeRole,
  configureRuntimeRole,
} from "../src/db/runtime-role.ts";
import {
  accounts,
  oauthClients,
  oauthResources,
  organizationCapabilities,
  organizations,
  sessions,
  users,
} from "../src/db/schema/index.ts";
import { createId } from "../src/lib/id.ts";
import { testEnvironment } from "../src/__tests__/support.ts";
import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";
import { startOidcIssuer } from "../src/__tests__/oidc-issuer.ts";
import { signInThroughIdp } from "../src/__tests__/federation.ts";
import { createOrganizationDomain } from "../src/__tests__/domain-queries.ts";
import { createSsoProvider } from "../src/__tests__/sso-queries.ts";

// Snapshot local disposable data into a fresh temporary cluster. Run serially.
assertDisposableTestDatabase("rehearse upstream backup restore");
const target = new URL(testDatabaseUrl);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.port, "47432");
assert.equal(target.username, "answerable");
assert.equal(target.search, "");
const directory = await mkdtemp(join(tmpdir(), "id-upstream-restore-"));
const archive = join(directory, "database.dump");
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function postgres(command: string[]) {
  const child = Bun.spawn(
    ["docker", "compose", "exec", "-T", "postgres", ...command],
    {
      cwd: root,
      stdin: "ignore",
      stdout: Bun.file(archive),
      stderr: "pipe",
    },
  );
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, `${command[0]} failed; restore rehearsal stopped`);
}
const issuer = await startOidcIssuer({
  refreshToken: "synthetic-restore-refresh",
});
const callbackURL = "https://restore.example.com/callback";
const keys = [1, 2].map((version) => ({
  version,
  value: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  ),
}));
const environment = testEnvironment({
  trustedOrigins: [issuer.origin, new URL(callbackURL).origin],
  upstreamTokenSecrets: [keys[0]!],
  rootAdminSecret: crypto.randomUUID(),
  rootAdminBreakGlass: true,
  operationReplay: {
    activeKeyId: "restore",
    keys: {
      restore: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      ),
    },
  },
});
let ownerUrl = environment.databaseUrl;
let replacement: Awaited<ReturnType<typeof restoreCluster>> | undefined;
let owner = createDatabase(environment);
let ownerOpen = true;
async function closeOwner() {
  if (ownerOpen) {
    ownerOpen = false;
    await owner.close();
  }
}
function reopenOwner() {
  owner = createDatabase({ ...environment, databaseUrl: ownerUrl });
  ownerOpen = true;
}
let runtime: ReturnType<typeof createDatabase> | undefined;
const role = `id_test_restore_${crypto.randomUUID().replaceAll("-", "")}`;
const password = crypto.randomUUID().replaceAll("-", "");
let runtimeUrl = new URL(testDatabaseUrl);
runtimeUrl.username = role;
runtimeUrl.password = password;
const orgId = createId();
const otherOrgId = createId();
const providerId = `restore-${orgId}`;
const directoryId = crypto.randomUUID();
const providerIssuer = `https://login.microsoftonline.com/${directoryId}/v2.0`;
const domain = `${orgId}.example.com`;
let userId: string | undefined;
let roleCreated = false;
try {
  const sourceSystem = await owner.db.execute<{ system_identifier: string }>(
    sql`select system_identifier::text from pg_control_system()`,
  );
  await runMigrations(owner.db);
  const verifyRuntime = await prepareRestoredRuntime(owner.db, environment);
  await configureRuntimeRole(owner.db, role);
  roleCreated = true;
  await owner.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  runtime = createDatabase({
    ...environment,
    databaseUrl: runtimeUrl.toString(),
  });
  await assertRuntimeRole(runtime.db);
  await owner.db
    .insert(organizations)
    .values({ id: orgId, name: "Restore proof", slug: providerId });
  await createOrganizationDomain(owner.db, { organizationId: orgId, domain });
  await createSsoProvider(owner.db, {
    organizationId: orgId,
    providerId,
    domain,
    issuer: providerIssuer,
    oidc: {
      clientId: providerId,
      clientSecret: "synthetic-restore-secret",
      authorizationEndpoint: `${issuer.origin}/authorize`,
      tokenEndpoint: `${issuer.origin}/token`,
      jwksEndpoint: `${issuer.origin}/jwks`,
    },
  });
  const claims = {
    sub: orgId,
    oid: orgId,
    tid: directoryId,
    iss: providerIssuer,
    email: `person@${domain}`,
    name: "Restore fixture",
  };
  const appFor = (upstreamTokenSecrets = environment.upstreamTokenSecrets) => {
    const config = { ...environment, upstreamTokenSecrets };
    return createApp({
      auth: createAuth(runtime!.db, config),
      db: runtime!.db,
      environment: config,
    });
  };
  issuer.enqueue(claims);
  const first = await signInThroughIdp(appFor(), { providerId, callbackURL });
  assert.equal(first.location, callbackURL);
  const [identity] = await owner.db
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, orgId));
  assert.ok(identity);
  userId = identity.userId;
  const { adapter } = await createAuth(runtime.db, environment).$context;
  const original = await adapter.findOne<Record<string, unknown>>({
    model: "account",
    where: [{ field: "id", value: identity.id }],
  });
  assert.ok(original);
  const ring = [keys[1]!, keys[0]!];
  const { adapter: rotating } = await createAuth(runtime.db, {
    ...environment,
    upstreamTokenSecrets: ring,
  }).$context;
  await rotating.update({
    model: "account",
    where: [{ field: "id", value: identity.id }],
    update: { idToken: original.idToken },
  });
  const [before] = await owner.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, identity.id));
  assert.ok(before?.accessToken?.startsWith("$ba$1$"));
  assert.ok(before.refreshToken?.startsWith("$ba$1$"));
  assert.ok(before.idToken?.startsWith("$ba$2$"));
  const beforeSessions = await owner.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const verifyCommands = await prepareRestoredCommands(
    owner.db,
    runtime.db,
    { ...environment, upstreamTokenSecrets: ring },
    {
      organizationId: orgId,
      otherOrganizationId: otherOrgId,
      userId,
      callbackURL,
    },
  );
  const otherDomain = `${otherOrgId}.example.com`;
  const otherProviderId = `restore-b-${otherOrgId}`;
  await createOrganizationDomain(owner.db, {
    organizationId: otherOrgId,
    domain: otherDomain,
  });
  await createSsoProvider(owner.db, {
    organizationId: otherOrgId,
    providerId: otherProviderId,
    domain: otherDomain,
    issuer: providerIssuer,
    oidc: {
      clientId: otherProviderId,
      clientSecret: "synthetic-restore-b-secret",
      authorizationEndpoint: `${issuer.origin}/authorize`,
      tokenEndpoint: `${issuer.origin}/token`,
      jwksEndpoint: `${issuer.origin}/jwks`,
    },
  });
  const verifySigning = await prepareRestoredSigning(
    owner.db,
    runtime.db,
    environment,
    orgId,
  );
  const verifyRetention = await prepareRestoredRetention(owner.db, environment);
  const receipt = await owner.db.execute(
    sql`select * from drizzle.__drizzle_migrations order by id`,
  );
  // Refuse a different Docker context even if it has a similarly named DB.
  const marker = Bun.spawn(
    [
      "docker",
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "answerable",
      "-d",
      "answerable_id_test",
      "-Atc",
      `select id from accounts where id = '${identity.id}'`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [markerCode, markerValue] = await Promise.all([
    marker.exited,
    new Response(marker.stdout).text(),
    new Response(marker.stderr).text(),
  ]);
  assert.equal(markerCode, 0, "Cannot verify the Compose database");
  assert.equal(
    markerValue.trim(),
    identity.id,
    "Compose and application databases differ",
  );
  await runtime.close();
  runtime = undefined;
  await closeOwner();
  await postgres([
    "pg_dump",
    "-U",
    "answerable",
    "-d",
    "answerable_id_test",
    "--format=custom",
  ]);
  replacement = await restoreCluster(root, archive);
  ownerUrl = replacement.url;
  reopenOwner();
  const replacementSystem = await owner.db.execute<{
    system_identifier: string;
  }>(sql`select system_identifier::text from pg_control_system()`);
  assert.notEqual(
    replacementSystem.rows[0]!.system_identifier,
    sourceSystem.rows[0]!.system_identifier,
  );
  assert.equal(
    (
      await owner.db.execute(
        sql`select 1 from pg_roles where rolname = ${role}`,
      )
    ).rows.length,
    0,
  );
  await configureRuntimeRole(owner.db, role);
  const replacementPassword = crypto.randomUUID().replaceAll("-", "");
  await owner.db.execute(
    sql.raw(`alter role "${role}" login password '${replacementPassword}'`),
  );
  runtimeUrl = new URL(replacement.url);
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const staleCredentials = createDatabase({
    ...environment,
    databaseUrl: runtimeUrl.toString(),
  });
  try {
    await assert.rejects(() => staleCredentials.pool.query("select 1"), {
      code: "28P01",
    });
  } finally {
    await staleCredentials.close();
  }
  runtimeUrl.password = replacementPassword;
  runtime = createDatabase({
    ...environment,
    databaseUrl: runtimeUrl.toString(),
  });
  await assertRuntimeRole(runtime.db);
  assert.deepEqual(
    (
      await owner.db.select().from(accounts).where(eq(accounts.id, identity.id))
    )[0],
    before,
  );
  assert.deepEqual(
    await owner.db.select().from(sessions).where(eq(sessions.userId, userId)),
    beforeSessions,
  );
  assert.deepEqual(
    (
      await owner.db.execute(
        sql`select * from drizzle.__drizzle_migrations order by id`,
      )
    ).rows,
    receipt.rows,
  );
  await runMigrations(owner.db);
  assert.deepEqual(
    (
      await owner.db.select().from(accounts).where(eq(accounts.id, identity.id))
    )[0],
    before,
  );
  await verifyCommands(owner.db, runtime.db);
  for (const retained of [[keys[1]!], [keys[0]!], undefined]) {
    const { adapter: missing } = await createAuth(runtime.db, {
      ...environment,
      upstreamTokenSecrets: retained,
    }).$context;
    await assert.rejects(
      () =>
        missing.findOne({
          model: "account",
          where: [{ field: "id", value: identity.id }],
        }),
      /Upstream token storage is unavailable/,
    );
  }
  const { adapter: restored } = await createAuth(runtime.db, {
    ...environment,
    upstreamTokenSecrets: ring,
  }).$context;
  const readable = await restored.findOne<Record<string, unknown>>({
    model: "account",
    where: [{ field: "id", value: identity.id }],
  });
  for (const field of ["accessToken", "refreshToken", "idToken"])
    assert.equal(readable?.[field], original[field]);
  const cookie = first.cookies
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const session = await appFor(ring).request("/auth/get-session", {
    headers: { Cookie: cookie },
  });
  assert.equal(session.status, 200);
  assert.equal(
    ((await session.json()) as { user: { id: string } }).user.id,
    userId,
  );
  await verifyRuntime(
    owner.db,
    {
      ...environment,
      databaseUrl: runtimeUrl.toString(),
      upstreamTokenSecrets: ring,
    },
    replacement.url,
    cookie,
    userId,
  );
  const sessionsBeforeDenied = await owner.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId));
  issuer.enqueue({ ...claims, email: `person@${otherDomain}` });
  const deniedTenant = await signInThroughIdp(appFor(ring), {
    providerId: otherProviderId,
    callbackURL,
  });
  assert.equal(
    new URL(deniedTenant.location!).searchParams.get("error"),
    "membership_revoked",
  );
  assert.deepEqual(
    await owner.db.select().from(sessions).where(eq(sessions.userId, userId)),
    sessionsBeforeDenied,
  );
  issuer.enqueue(claims);
  const next = await signInThroughIdp(appFor(ring), {
    providerId,
    callbackURL,
  });
  assert.equal(next.location, callbackURL);
  const [renewed] = await owner.db
    .select()
    .from(accounts)
    .where(eq(accounts.id, identity.id));
  assert.equal(renewed?.userId, userId);
  assert.equal(renewed?.issuer, before.issuer);
  assert.equal(renewed?.accountId, before.accountId);
  for (const value of [
    renewed?.accessToken,
    renewed?.refreshToken,
    renewed?.idToken,
  ])
    assert.ok(value?.startsWith("$ba$2$"));
  await verifySigning(owner.db, runtime.db);
  await verifyRetention(owner.db, runtime.db, {
    ...environment,
    databaseUrl: replacement.url,
  });
  console.log(
    "PASS: restored signing keys verify old/new machine tokens and refuse missing decryption custody without replacement keys or successful issuance; rebuilt retention role purges only expired ciphertext with atomic evidence and preserved reservations; restored production startup rejects an owner login and survives two clean HTTP starts without changing bootstrap policy; fresh-cluster PostgreSQL restore rebuilds runtime permissions with new login credentials and preserves ciphertext, sessions, migration receipts and restricted runtime permissions; separate retained keys recover values, missing keys refuse reads, native SSO preserves A and denies revoked B; restored commands recover the same secrets without repeating effects, reject unavailable keys/conflicts, and retain expired reservations.",
  );
} finally {
  await runtime?.close();
  // The replacement cluster is discarded; clean only our source fixture rows.
  await closeOwner();
  ownerUrl = environment.databaseUrl;
  reopenOwner();
  try {
    await owner.db
      .delete(organizationCapabilities)
      .where(
        inArray(organizationCapabilities.organizationId, [orgId, otherOrgId]),
      );
    if (userId) await owner.db.delete(users).where(eq(users.id, userId));
    await owner.db
      .delete(oauthClients)
      .where(inArray(oauthClients.organizationId, [orgId, otherOrgId]));
    await owner.db
      .delete(oauthResources)
      .where(inArray(oauthResources.organizationId, [orgId, otherOrgId]));
    await owner.db
      .delete(organizations)
      .where(inArray(organizations.id, [orgId, otherOrgId]));
    if (roleCreated) {
      await owner.db.execute(sql`drop owned by ${sql.identifier(role)}`);
      await owner.db.execute(sql`drop role ${sql.identifier(role)}`);
    }
  } finally {
    await closeOwner();
    issuer.stop();
    try {
      await replacement?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
