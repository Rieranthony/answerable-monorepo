import assert from "node:assert/strict";
import { cpus, totalmem } from "node:os";
import { eq, sql } from "drizzle-orm";
import { createAdminFixture } from "../src/__tests__/admin.ts";
import {
  assertDisposableTestDatabase,
  testDatabaseUrl,
} from "../src/__tests__/test-database.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { createDatabase } from "../src/db/client.ts";
import { configureRuntimeRole } from "../src/db/runtime-role.ts";
import {
  groups,
  organizations,
  oauthResources,
  entitlements,
} from "../src/db/schema/index.ts";
import { createId } from "../src/lib/id.ts";

// Destructive synthetic measurement, deliberately separate from the correctness suite.
// Never run concurrently with other database tests. No production URL is accepted.
assertDisposableTestDatabase("measure audit workloads");
const databaseTarget = new URL(testDatabaseUrl);
assert.ok(["localhost", "127.0.0.1"].includes(databaseTarget.hostname));
assert.equal(databaseTarget.port, "47432");
assert.equal(databaseTarget.search, "");
const output = process.argv[2];
assert.ok(output, "Pass an output JSON path");
const mode = process.argv[3] ?? "audience";
assert.ok(["audience", "member-assignments", "user-erasure"].includes(mode));
const sizes = mode !== "audience" ? [10, 100, 1_000] : [100, 1_000, 10_000];
const results: unknown[] = [];
const checks: unknown[] = [];
const metadata = {
  bun: Bun.version,
  platform: process.platform,
  arch: process.arch,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  memoryBytes: totalmem(),
  poolMax: 4,
  connectionTimeoutMs: 1_000,
  statementTimeoutMs: 10_000,
  sizes,
  dimension:
    mode === "user-erasure"
      ? "group assignments and distinct direct resource grants per membership; eight global users each belong to two tenants"
      : mode === "member-assignments"
        ? "effective group assignments per member; eight members share the groups and one admin resource"
        : "members per organisation",
  countedUserRelationship: mode === "user-erasure" ? "target" : "affected",
  topology:
    "one Bun loopback HTTP server and one restricted pool; local PostgreSQL",
  limits:
    "Single observations, not production capacity, percentiles or a peak-memory guarantee. RSS samples include this measurement process and are a lower bound on transient peaks.",
};
async function save() {
  await Bun.write(
    output!,
    JSON.stringify({ metadata, results, checks }, null, 2) + "\n",
  );
}
await save();
for (const size of sizes) {
  const fixture = await createAdminFixture();
  const role = `id_test_audit_load_${crypto.randomUUID().replaceAll("-", "")}`;
  const password = crypto.randomUUID().replaceAll("-", "");
  let runtime: ReturnType<typeof createDatabase> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await configureRuntimeRole(fixture.db, role);
    await fixture.db.execute(
      sql.raw(`alter role "${role}" login password '${password}'`),
    );
    const url = new URL(fixture.environment.databaseUrl);
    url.username = role;
    url.password = password;
    const environment = {
      ...fixture.environment,
      databaseUrl: url.toString(),
      databasePoolMax: metadata.poolMax,
    };
    runtime = createDatabase(environment);
    const app = createApp({
      db: runtime.db,
      auth: createAuth(runtime.db, environment),
      environment,
    });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const origin = server.url.origin;
    const organizationId = createId();
    await fixture.db.insert(organizations).values({
      id: organizationId,
      slug: `load-${size}`,
      name: "Synthetic workload",
    });
    const groupId = createId();
    if (mode === "audience") {
      await fixture.db.insert(groups).values({
        id: groupId,
        organizationId,
        slug: "audience",
        name: "Synthetic audience",
      });
      await fixture.db.execute(sql`
      with seeded as (
        insert into users (id, name, email, status)
        select gen_random_uuid(), 'Synthetic', ${organizationId} || '-' || n || '@example.invalid', 'active'
        from generate_series(1, ${size}) n returning id
      ) insert into members (id, organization_id, user_id)
        select gen_random_uuid(), ${organizationId}::uuid, id from seeded`);
      await fixture.db.execute(sql`
      insert into group_members (id, organization_id, group_id, member_id)
      select gen_random_uuid(), ${organizationId}::uuid, ${groupId}::uuid, id
      from members where organization_id = ${organizationId}::uuid`);
      // Planner statistics must represent the measured population, not the previous tiny fixture.
      await fixture.db.execute(sql`analyze users`);
      await fixture.db.execute(sql`analyze members`);
      await fixture.db.execute(sql`analyze group_members`);
    }
    async function request(
      path: string,
      method: string,
      body?: unknown,
      key: string = crypto.randomUUID(),
      tag?: string,
    ) {
      const headers = fixture.headers("root");
      headers.set("Idempotency-Key", key);
      if (tag !== undefined) headers.set("If-Match", tag);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const started = performance.now();
      const response = await fetch(`${origin}/api/admin/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        ms: performance.now() - started,
        operationId: response.headers.get("Operation-Id"),
        replayed: response.headers.get("Idempotency-Replayed"),
        body:
          text && response.headers.get("Content-Type")?.includes("json")
            ? JSON.parse(text)
            : text,
      };
    }
    const probePath = `/organizations/${fixture.outsider.organizationId}/groups`;
    async function observe(
      name: string,
      run: () => Promise<Awaited<ReturnType<typeof request>>[]>,
    ) {
      const probes: { status: number; ms: number; code?: string }[] = [];
      let active = true;
      const rssBefore = process.memoryUsage.rss();
      let maxPoolWaiting = 0,
        maxPoolTotal = 0,
        busyPoolSamples = 0;
      let rssSampledMax = rssBefore,
        maxTimerGapMs = 0,
        tick = performance.now();
      const timer = setInterval(() => {
        maxPoolWaiting = Math.max(maxPoolWaiting, runtime!.pool.waitingCount);
        maxPoolTotal = Math.max(maxPoolTotal, runtime!.pool.totalCount);
        if (
          runtime!.pool.totalCount === metadata.poolMax &&
          runtime!.pool.idleCount === 0
        )
          busyPoolSamples++;
        rssSampledMax = Math.max(rssSampledMax, process.memoryUsage.rss());
        const now = performance.now();
        maxTimerGapMs = Math.max(maxTimerGapMs, now - tick);
        tick = now;
      }, 10);
      const probesDone = (async () => {
        do {
          const response = await request(probePath, "GET");
          probes.push({
            status: response.status,
            ms: response.ms,
            code: response.body?.code,
          });
          await Bun.sleep(20);
        } while (active);
      })();
      const started = performance.now();
      let responses: Awaited<ReturnType<typeof request>>[];
      try {
        responses = await run();
      } finally {
        active = false;
        clearInterval(timer);
        await probesDone;
      }
      const elapsedMs = performance.now() - started;
      const events = [];
      for (const response of responses) {
        if (!response.operationId) continue;
        const rows = await fixture.db.execute(sql`
          select action, octet_length(data::text) as json_bytes,
            (select count(*)::int from audit_event_subjects s where s.event_id = e.id and s.relationship = ${mode === "user-erasure" ? "target" : "affected"} and s.entity_type = 'user') as users
          from audit_events e where operation_id = ${response.operationId}::uuid`);
        assert.equal(
          rows.rows.length,
          1,
          "Each committed command must have one domain audit fact",
        );
        for (const event of rows.rows)
          assert.equal(
            event.users,
            mode !== "audience" ? 1 : size,
            "No audience truncation is permitted",
          );
        events.push(...rows.rows);
      }
      const record = {
        size,
        name,
        elapsedMs,
        rssBefore,
        rssSampledMax,
        maxTimerGapMs,
        maxPoolWaiting,
        maxPoolTotal,
        busyPoolSamples,
        requests: responses.map(({ status, ms, replayed, body }) => ({
          status,
          ms,
          replayed,
          code: body?.code,
        })),
        probes,
        events,
      };
      results.push(record);
      await save();
      console.log(
        JSON.stringify({
          size,
          name,
          elapsedMs: Math.round(elapsedMs),
          statuses: responses.map((r) => r.status),
          otherTenantFailures: probes.filter((p) => p.status !== 200).length,
          events,
        }),
      );
      return responses;
    }
    const baseline = await observe("other-tenant-baseline", async () => [
      await request(probePath, "GET"),
    ]);
    assert.equal(baseline[0]!.status, 200);
    const path = `/organizations/${organizationId}`;
    if (mode === "user-erasure") {
      const otherId = fixture.outsider.organizationId;
      const seeded = await fixture.db.execute<{ id: string }>(sql`
        insert into users (id, name, email, status)
        select gen_random_uuid(), 'Synthetic', ${organizationId} || '-erase-' || n || '@example.invalid', 'active'
        from generate_series(1, 8) n returning id`);
      const targets = seeded.rows.map(({ id }) => ({
        id,
        key: crypto.randomUUID(),
      }));
      for (const target of targets) {
        await fixture.db.execute(sql`
          insert into members (id, organization_id, user_id)
          select gen_random_uuid(), id, ${target.id}::uuid from organizations
          where id in (${organizationId}::uuid, ${otherId}::uuid)`);
      }
      await fixture.db.execute(sql`
        insert into groups (id, organization_id, slug, name)
        select gen_random_uuid(), o.id, 'erase-density-' || n, 'Synthetic'
        from organizations o cross join generate_series(1, ${size}) n
        where o.id in (${organizationId}::uuid, ${otherId}::uuid)`);
      await fixture.db.execute(sql`
        insert into oauth_resources (id, identifier, name, allowed_scopes)
        select gen_random_uuid(), 'https://' || ${organizationId} || '.example.invalid/' || n,
          'Synthetic', ARRAY['org:read']::text[] from generate_series(1, ${size}) n`);
      for (const target of targets) {
        await fixture.db.execute(sql`
          insert into group_members (id, organization_id, group_id, member_id)
          select gen_random_uuid(), m.organization_id, g.id, m.id
          from members m join groups g on g.organization_id = m.organization_id
          where m.user_id = ${target.id}::uuid and g.slug like 'erase-density-%'`);
        await fixture.db.execute(sql`
          insert into entitlements (id, organization_id, member_id, resource, scopes)
          select gen_random_uuid(), m.organization_id, m.id, r.identifier, ARRAY['org:read']::text[]
          from members m cross join oauth_resources r
          where m.user_id = ${target.id}::uuid and r.identifier like ${"https://" + organizationId + ".example.invalid/%"}`);
      }
      for (const table of [
        "users",
        "members",
        "groups",
        "group_members",
        "entitlements",
      ])
        await fixture.db.execute(sql`analyze ${sql.identifier(table)}`);
      const unaffected = await fixture.db.execute(sql`
        select id, organization_id, user_id, status from members
        where organization_id = ${otherId}::uuid and user_id not in
          (select id from users where email like ${organizationId + "-erase-%"}) order by id`);
      const initial = await observe("eight-global-user-erasures", () =>
        Promise.all(
          targets.map((target) =>
            request(
              `/users/${target.id}?confirm=${target.id}`,
              "DELETE",
              undefined,
              target.key,
            ),
          ),
        ),
      );
      for (const [index, first] of initial.entries()) {
        const target = targets[index]!;
        assert.ok([204, 503].includes(first.status));
        let final = first;
        if (first.status === 503) {
          const recovery = await observe(
            `user-erasure-recovery-${index}`,
            async () => [
              await request(
                `/users/${target.id}?confirm=${target.id}`,
                "DELETE",
                undefined,
                target.key,
              ),
            ],
          );
          final = recovery[0]!;
        }
        assert.ok([204, 503].includes(final.status));
        const state = await fixture.db.execute<{
          users: number;
          memberships: number;
          assignments: number;
          entitlements: number;
          events: number;
        }>(sql`
          select
            (select count(*)::int from users where id = ${target.id}::uuid) as users,
            (select count(*)::int from members where user_id = ${target.id}::uuid) as memberships,
            (select count(*)::int from group_members gm join members m on m.id = gm.member_id where m.user_id = ${target.id}::uuid) as assignments,
            (select count(*)::int from entitlements e join members m on m.id = e.member_id where m.user_id = ${target.id}::uuid) as entitlements,
            (select count(*)::int from audit_events where action = 'user.erased' and target_id = ${target.id}) as events`);
        const committed = final.status === 204;
        assert.deepEqual(state.rows[0], {
          users: committed ? 0 : 1,
          memberships: committed ? 0 : 2,
          assignments: committed ? 0 : size * 2,
          entitlements: committed ? 0 : size * 2,
          events: committed ? 1 : 0,
        });
        let manifest: unknown = null;
        if (committed) {
          const evidence = await fixture.db.execute(sql`
            select jsonb_array_length(data #> '{effects,removedMembers}') as memberships,
              jsonb_array_length(data #> '{effects,removedAssignments}') as assignments,
              jsonb_array_length(data #> '{effects,removedEntitlements}') as entitlements
            from audit_events where operation_id = ${final.operationId}::uuid`);
          manifest = evidence.rows[0];
          assert.deepEqual(manifest, {
            memberships: 2,
            assignments: size * 2,
            entitlements: size * 2,
          });
          const replay = await observe(
            `user-erasure-replay-${index}`,
            async () => [
              await request(
                `/users/${target.id}?confirm=${target.id}`,
                "DELETE",
                undefined,
                target.key,
              ),
            ],
          );
          assert.equal(replay[0]!.status, 204);
          assert.equal(replay[0]!.replayed, "true");
          assert.equal(replay[0]!.operationId, final.operationId);
        }
        checks.push({
          size,
          user: index,
          status: final.status,
          ...state.rows[0],
          manifest,
        });
        await save();
      }
      const retained = await fixture.db.execute(sql`
        select id, organization_id, user_id, status from members
        where organization_id = ${otherId}::uuid and user_id not in
          (select id from users where email like ${organizationId + "-erase-%"}) order by id`);
      assert.deepEqual(retained.rows, unaffected.rows);
      const retainedGroups = await fixture.db.execute(sql`
        select count(*)::int as n from groups where organization_id in (${organizationId}::uuid, ${otherId}::uuid) and slug like 'erase-density-%'`);
      assert.equal(retainedGroups.rows[0]!.n, size * 2);
      checks.push({
        size,
        unaffectedMembers: retained.rows.length,
        retainedGroups: size * 2,
      });
      await save();
      continue;
    }
    if (mode === "member-assignments") {
      await fixture.db.execute(sql`
        with seeded as (
          insert into users (id, name, email, status)
          select gen_random_uuid(), 'Synthetic', ${organizationId} || '-' || n || '@example.invalid', 'active'
          from generate_series(1, 8) n returning id
        ) insert into members (id, organization_id, user_id)
          select gen_random_uuid(), ${organizationId}::uuid, id from seeded`);
      await fixture.db.execute(sql`
        insert into groups (id, organization_id, slug, name)
          select gen_random_uuid(), ${organizationId}::uuid, 'dense-' || n, 'Synthetic'
          from generate_series(1, ${size}) n`);
      await fixture.db.execute(sql`
        insert into group_members (id, organization_id, group_id, member_id)
          select gen_random_uuid(), m.organization_id, g.id, m.id
          from members m join groups g on g.organization_id = m.organization_id
          where m.organization_id = ${organizationId}::uuid`);
      await fixture.db.execute(sql`
        insert into entitlements (id, organization_id, group_id, resource, scopes)
          select gen_random_uuid(), organization_id, id, ${fixture.platform.adminResource}, ARRAY['org:read']::text[]
          from groups where organization_id = ${organizationId}::uuid`);
      await fixture.db.execute(sql`
        insert into organization_capabilities (id, organization_id, resource, grant_kind, scopes)
          values (gen_random_uuid(), ${organizationId}::uuid, ${fixture.platform.adminResource}, 'admin_session', ARRAY['org:read']::text[])`);
      for (const table of [
        "users",
        "members",
        "groups",
        "group_members",
        "entitlements",
        "organization_capabilities",
      ])
        await fixture.db.execute(sql`analyze ${sql.identifier(table)}`);
      const population = await fixture.db.execute<{
        id: string;
        revision: number;
      }>(sql`
        select id, revision from members where organization_id = ${organizationId}::uuid order by id`);
      const targets = population.rows.map((member) => ({
        ...member,
        key: crypto.randomUUID(),
        tag: `"${member.id}:${member.revision}"`,
      }));
      const body = { validUntil: "2000-01-01T00:00:00.000Z" };
      const results = await observe("eight-dense-member-window-commands", () =>
        Promise.all(
          targets.map((target) =>
            request(
              `${path}/members/${target.id}`,
              "PATCH",
              body,
              target.key,
              target.tag,
            ),
          ),
        ),
      );
      for (const [index, initial] of results.entries()) {
        const target = targets[index]!;
        assert.ok([200, 503].includes(initial.status));
        let final = initial;
        if (initial.status === 503) {
          const recovered = await observe(
            `dense-member-recovery-${index}`,
            async () => [
              await request(
                `${path}/members/${target.id}`,
                "PATCH",
                body,
                target.key,
                target.tag,
              ),
            ],
          );
          assert.equal(recovered.length, 1);
          final = recovered[0]!;
          assert.ok([200, 503].includes(final.status));
        }
        const state = await fixture.db.execute<{
          revision: number;
          expired: boolean;
          events: number;
        }>(sql`
          select revision, valid_until is not null as expired,
            (select count(*)::int from audit_events where action = 'member.updated' and target_id = ${target.id}) as events
          from members where id = ${target.id}::uuid`);
        assert.equal(state.rows[0]!.events, final.status === 200 ? 1 : 0);
        assert.equal(state.rows[0]!.expired, final.status === 200);
        assert.equal(
          state.rows[0]!.revision,
          target.revision + (final.status === 200 ? 1 : 0),
        );
        const check = {
          size,
          member: index,
          status: final.status,
          ...state.rows[0]!,
        };
        if (final.status !== 200) {
          checks.push(check);
          await save();
          continue;
        }
        assert.ok(final.operationId);
        const evidence = await fixture.db.execute<{
          sources: number;
          assignments: number;
          after_targets: number;
        }>(sql`
          select jsonb_array_length(data #> '{before,access,targets,0,permission,evidence,assignments}') as sources,
            jsonb_array_length(data #> '{before,access,targets,0,via}') as assignments,
            jsonb_array_length(data #> '{after,access,targets}') as after_targets
          from audit_events where operation_id = ${final.operationId}::uuid`);
        assert.equal(evidence.rows[0]!.sources, size);
        assert.equal(evidence.rows[0]!.assignments, size);
        assert.equal(evidence.rows[0]!.after_targets, 0);
        checks.push({ ...check, ...evidence.rows[0]! });
        const [replay] = await observe(
          `dense-member-replay-${index}`,
          async () => [
            await request(
              `${path}/members/${target.id}`,
              "PATCH",
              body,
              target.key,
              target.tag,
            ),
          ],
        );
        assert.equal(replay!.status, 200);
        assert.equal(replay!.replayed, "true");
      }
      continue;
    }
    for (const principal of ["organisation", "group"] as const) {
      const response = await observe(
        `${principal}-entitlement-create`,
        async () => [
          await request(`${path}/entitlements`, "POST", {
            resource: fixture.platform.adminResource,
            scopes: ["org:read"],
            ...(principal === "group" ? { groupId } : {}),
          }),
        ],
      );
      assert.equal(response[0]!.status, 201);
    }
    for (const status of ["disable", "enable"])
      assert.equal(
        (
          await observe(`group-${status}`, async () => [
            await request(`${path}/groups/${groupId}/${status}`, "POST"),
          ])
        )[0]!.status,
        200,
      );
    assert.equal(
      (
        await observe("group-erase", async () => [
          await request(
            `${path}/groups/${groupId}?confirm=${groupId}`,
            "DELETE",
          ),
        ])
      )[0]!.status,
      204,
    );
    const targets: { id: string; key: string }[] = [];
    for (let n = 0; n < 8; n++) {
      const identifier = `https://audit-load-${size}-${n}.example.invalid`;
      await fixture.db.insert(oauthResources).values({
        id: createId(),
        identifier,
        name: "Synthetic",
        allowedScopes: ["read"],
      });
      const id = createId();
      await fixture.db
        .insert(entitlements)
        .values({ id, organizationId, resource: identifier, scopes: ["read"] });
      targets.push({ id, key: crypto.randomUUID() });
    }
    const saturated = await observe("eight-same-tenant-commands", () =>
      Promise.all(
        targets.map(({ id, key }) =>
          request(`${path}/entitlements/${id}/disable`, "POST", undefined, key),
        ),
      ),
    );
    // Retry only failures, with the original keys; never hide initial refusals in the results.
    for (const [index, response] of saturated.entries()) {
      assert.ok([200, 503].includes(response.status));
      if (response.status !== 200) {
        const target = targets[index]!;
        assert.equal(
          (
            await observe(`recovery-${index}`, async () => [
              await request(
                `${path}/entitlements/${target.id}/disable`,
                "POST",
                undefined,
                target.key,
              ),
            ])
          )[0]!.status,
          200,
        );
      }
    }
    for (const { id } of targets) {
      const [row] = await fixture.db
        .select()
        .from(entitlements)
        .where(eq(entitlements.id, id));
      assert.equal(row?.status, "disabled");
      const count = await fixture.db.execute(
        sql`select count(*)::int as n from audit_events where action = 'entitlement.disabled' and target_id = ${id}`,
      );
      assert.equal(count.rows[0]!.n, 1);
    }
    const eraseKey = crypto.randomUUID();
    for (const name of ["organisation-erase", "organisation-erase-replay"]) {
      const [response] = await observe(name, async () => [
        await request(
          `${path}?confirm=${organizationId}`,
          "DELETE",
          undefined,
          eraseKey,
        ),
      ]);
      assert.equal(response!.status, 204);
      assert.equal(response!.replayed, String(name.endsWith("replay")));
    }
  } finally {
    server?.stop(true);
    await runtime?.close();
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
}
console.log(`Saved ${results.length} observations to ${output}`);
