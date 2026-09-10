import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { bootstrap, systemActor } from "../bootstrap.ts";
import type { Database } from "../db/client.ts";
import type { Environment } from "../env.ts";
import {
  auditEvents,
  entitlements,
  groups,
  oauthResources,
  organizationCapabilities,
  organizations,
  systemBindings,
} from "../db/schema/index.ts";

/** Match operator configuration to persisted system identities before the dump. */
export async function prepareRestoredRuntime(
  db: Database,
  environment: Environment,
) {
  const [existing] = await db
    .select()
    .from(systemBindings)
    .where(eq(systemBindings.name, "platform"));
  if (existing) {
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, existing.organizationId));
    const [resource] = await db
      .select()
      .from(oauthResources)
      .where(eq(oauthResources.id, existing.resourceId));
    assert.ok(organization && resource);
    environment.platformOrganizationSlug = organization.slug;
    environment.platformOrganizationName = organization.name;
    environment.adminResourceIdentifier = resource.identifier;
  }
  const seeded = await bootstrap(
    db,
    systemActor("restore-source-bootstrap"),
    environment,
  );
  async function snapshot(database: Database) {
    return {
      bindings: await database.select().from(systemBindings),
      organization: await database
        .select()
        .from(organizations)
        .where(eq(organizations.id, seeded.organization.id)),
      resource: await database
        .select()
        .from(oauthResources)
        .where(eq(oauthResources.id, seeded.resource.id)),
      groups: await database
        .select()
        .from(groups)
        .where(eq(groups.organizationId, seeded.organization.id))
        .orderBy(groups.id),
      entitlements: await database
        .select()
        .from(entitlements)
        .where(eq(entitlements.organizationId, seeded.organization.id))
        .orderBy(entitlements.id),
      capabilities: await database
        .select()
        .from(organizationCapabilities)
        .where(
          eq(organizationCapabilities.organizationId, seeded.organization.id),
        )
        .orderBy(organizationCapabilities.id),
    };
  }
  const before = await snapshot(db);
  const bootEvents = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "bootstrap.applied"));
  return async (
    database: Database,
    runtimeEnvironment: Environment,
    ownerUrl: string,
    cookie: string,
    userId: string,
  ) => {
    async function worker(databaseUrl: string, permitted: boolean) {
      const ready = Promise.withResolvers<string>();
      void ready.promise.catch(() => {});
      let listened = false;
      let refusedUnsafeRole = false;
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./restore-runtime-worker.ts", import.meta.url).pathname,
        ],
        {
          stdin: "pipe",
          env: { ...Bun.env, NODE_ENV: "production" },
          stdout: "ignore",
          stderr: "pipe",
          ipc(message) {
            const event = message as {
              stage: string;
              url: string;
              reason?: string;
            };
            if (event.stage === "listening") listened = true;
            if (event.stage === "ready") ready.resolve(event.url);
            if (event.stage === "failed") {
              refusedUnsafeRole = event.reason === "unsafe_role";
              ready.resolve("");
            }
          },
        },
      );
      // Drain diagnostics without exposing credential-bearing provider output.
      const diagnostics = new Response(child.stderr).text();
      child.stdin.write(
        JSON.stringify({
          ...runtimeEnvironment,
          databaseUrl,
          port: 0,
          nodeEnv: "production",
        }),
      );
      child.stdin.end();
      void child.exited.then((code) =>
        ready.reject(
          new Error(`Restore worker exited (${code}) before readiness`),
        ),
      );
      const timer = setTimeout(
        () => ready.reject(new Error("Restore worker readiness timed out")),
        15_000,
      );
      try {
        const url = await ready.promise;
        if (!permitted) {
          assert.equal(url, "");
          assert.equal(refusedUnsafeRole, true);
          assert.equal(listened, false);
          assert.equal(await child.exited, 1);
          return;
        }
        assert.ok(listened && url);
        for (const path of ["/healthz", "/readyz", "/auth/ok"]) {
          const response = await fetch(new URL(path, url), {
            signal: AbortSignal.timeout(5_000),
          });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
        }
        const session = await fetch(new URL("/auth/get-session", url), {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(session.status, 200);
        assert.equal(
          ((await session.json()) as { user: { id: string } }).user.id,
          userId,
        );
        child.kill("SIGTERM");
        assert.equal(await child.exited, 0);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await diagnostics;
      }
    }
    await worker(ownerUrl, false);
    assert.deepEqual(await snapshot(database), before);
    for (let attempt = 0; attempt < 2; attempt++) {
      await worker(runtimeEnvironment.databaseUrl, true);
      assert.deepEqual(await snapshot(database), before);
    }
    const events = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "bootstrap.applied"));
    const priorIds = new Set(bootEvents.map((event) => event.id));
    const starts = events.filter((event) => !priorIds.has(event.id));
    assert.equal(starts.length, 2);
    for (const event of starts) {
      assert.equal(event.actorType, "system");
      assert.equal(event.actorId, "startup");
      assert.equal(event.organizationId, seeded.organization.id);
      const data = event.data as Record<
        string,
        { created: boolean; updated: boolean }
      >;
      for (const key of [
        "organization",
        "resource",
        "group",
        "entitlement",
        "capability",
      ])
        assert.deepEqual(
          { created: data[key]!.created, updated: data[key]!.updated },
          { created: false, updated: false },
        );
    }
  };
}
