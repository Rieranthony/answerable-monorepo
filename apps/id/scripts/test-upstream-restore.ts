import { prepareRestoredDeletion } from "../src/__tests__/restore-deletion.ts";
import { prepareRecoveryGap } from "../src/__tests__/restore-reconciliation.ts";
import { checkKeyCustody } from "../src/operations/preflight.ts";
import { prepareRestoredSigning } from "../src/__tests__/restore-signing.ts";
import { prepareRestoredRetention } from "../src/__tests__/restore-retention.ts";
import { prepareRestoredRuntime } from "../src/__tests__/restore-runtime.ts";
import { restoreCluster } from "../src/__tests__/restore-cluster.ts";
import { prepareRestoredCommands } from "../src/__tests__/restore-commands.ts";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Reset and seed the local disposable database, then restore into a fresh cluster. Run serially.
assertDisposableTestDatabase("rehearse upstream backup restore");
const target = new URL(testDatabaseUrl);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.equal(target.port, "47432");
assert.equal(target.username, "answerable");
assert.equal(target.search, "");
const directory = await mkdtemp(join(tmpdir(), "id-upstream-restore-"));
const archive = join(directory, "database.dump");
const reconciledArchive = join(directory, "reconciled.dump");
const phases: { phase: string; elapsedMs: number }[] = [];
let phaseStart = performance.now();
function measured(phase: string) {
  const now = performance.now();
  phases.push({ phase, elapsedMs: now - phaseStart });
  phaseStart = now;
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function postgres(command: string[], destination = archive) {
  const child = Bun.spawn(
    ["docker", "compose", "exec", "-T", "postgres", ...command],
    {
      cwd: root,
      stdin: "ignore",
      stdout: Bun.file(destination),
      stderr: "pipe",
    },
  );
  const [code] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, `${command[0]} failed; restore rehearsal stopped`);
  await chmod(destination, 0o600);
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
let gapUserId: string | undefined;
let roleCreated = false;
try {
  const sourceSystem = await owner.db.execute<{ system_identifier: string }>(
    sql`select system_identifier::text from pg_control_system()`,
  );
  // Other tests deliberately leave ciphertext with unrelated keys. Start this
  // custody rehearsal with one complete, self-contained synthetic key inventory.
  await import("./reset-test-schema.ts");
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
  const verifyDeletion = await prepareRestoredDeletion(
    owner.db,
    runtime.db,
    environment,
    orgId,
    userId,
  );
  const gap = await prepareRecoveryGap(
    owner.db,
    environment,
    orgId,
    otherOrgId,
  );
  gapUserId = gap.userId;
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
  measured("prepare_and_original_dump");
  // The still-available source receives acknowledged writes after the original snapshot.
  reopenOwner();
  runtime = createDatabase({
    ...environment,
    databaseUrl: runtimeUrl.toString(),
  });
  const reconciliation = await gap.commit(owner.db, runtime.db);
  const evidencePath = join(directory, "recovery-evidence.json");
  const inputPath = join(directory, "recovery-ids.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      operationIds: reconciliation.evidence.operations.map(
        (operation) => operation.id,
      ),
      revokedMemberIds: reconciliation.evidence.revokedMemberIds,
      deletedClientIds: reconciliation.evidence.deletedClientIds,
    }),
    {
      mode: 0o600,
    },
  );
  async function operatorCommand(
    script: string,
    args: string[],
    expected: number,
  ) {
    const child = Bun.spawn(
      [process.execPath, new URL(script, import.meta.url).pathname, ...args],
      {
        env: {
          PATH: Bun.env.PATH,
          NODE_ENV: "production",
          DATABASE_URL: runtimeUrl.toString(),
          BETTER_AUTH_URL: environment.betterAuthUrl,
          BETTER_AUTH_SECRET: environment.betterAuthSecret,
          UPSTREAM_TOKEN_SECRETS: JSON.stringify(ring),
          OPERATION_REPLAY_CONFIG: JSON.stringify(environment.operationReplay),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(
      code,
      expected,
      "Operator command returned an unexpected status",
    );
  }
  await operatorCommand("capture-recovery.ts", [inputPath, evidencePath], 0);
  assert.deepEqual(
    await Bun.file(evidencePath).json(),
    reconciliation.evidence,
  );
  // Capture must refuse to replace independently retained evidence.
  await operatorCommand("capture-recovery.ts", [inputPath, evidencePath], 1);
  await runtime.close();
  runtime = undefined;
  await closeOwner();
  await postgres(
    [
      "pg_dump",
      "-U",
      "answerable",
      "-d",
      "answerable_id_test",
      "--format=custom",
    ],
    reconciledArchive,
  );
  measured("post_snapshot_commands_and_complete_reconciliation_dump");
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
  await reconciliation.verifyOld(owner.db, runtime.db);
  await operatorCommand("verify-recovery.ts", [evidencePath], 1);
  measured("old_snapshot_restored_and_reopening_refused");
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
  await verifyDeletion(owner.db, runtime.db);
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
  measured("existing_restore_contracts");
  await runtime.close();
  runtime = undefined;
  await closeOwner();
  await replacement.close();
  replacement = undefined;
  // Reconcile by restoring the complete later source, not by copying selected receipt/audit rows.
  replacement = await restoreCluster(root, reconciledArchive);
  ownerUrl = replacement.url;
  reopenOwner();
  await configureRuntimeRole(owner.db, role);
  const reconciledPassword = crypto.randomUUID().replaceAll("-", "");
  await owner.db.execute(
    sql.raw(`alter role "${role}" login password '${reconciledPassword}'`),
  );
  runtimeUrl = new URL(replacement.url);
  runtimeUrl.username = role;
  runtimeUrl.password = reconciledPassword;
  runtime = createDatabase({
    ...environment,
    databaseUrl: runtimeUrl.toString(),
  });
  await assertRuntimeRole(runtime.db);
  await reconciliation.verifyRecovered(owner.db, runtime.db);
  const custody = await checkKeyCustody(runtime.db, {
    ...environment,
    upstreamTokenSecrets: ring,
  });
  await operatorCommand("operations-preflight.ts", [], 0);
  await operatorCommand("verify-recovery.ts", [evidencePath], 0);
  measured("complete_reconciliation_restore_custody_and_replay");
  const evidence = {
    event: "synthetic_recovery_verified",
    scope: "local_two_snapshot_rehearsal",
    reconciliationSource:
      "complete_later_dump_of_still_available_synthetic_source",
    listedOperations: 4,
    trafficRefusedOnGap: true,
    productionRtoRpo: "unknown",
    custody,
    phases,
  };
  console.log(JSON.stringify(evidence));
  if (process.argv[2])
    await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
  console.log(
    "PASS: restored product tombstones remain inactive and credential-free, retain UUID subjects and identifier reservations, and replay deletion without another transition; restored signing keys verify old/new machine tokens and refuse missing decryption custody without replacement keys or successful issuance; rebuilt retention role purges only expired ciphertext with atomic evidence and preserved reservations; restored production startup rejects an owner login and survives two clean HTTP starts without changing bootstrap policy; fresh-cluster PostgreSQL restore rebuilds runtime permissions with new login credentials and preserves ciphertext, sessions, migration receipts and restricted runtime permissions; separate retained keys recover values, missing keys refuse reads, native SSO preserves A and denies revoked B; restored commands recover the same secrets without repeating effects, reject unavailable keys/conflicts, and retain expired reservations.",
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
    if (gapUserId) await owner.db.delete(users).where(eq(users.id, gapUserId));
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
