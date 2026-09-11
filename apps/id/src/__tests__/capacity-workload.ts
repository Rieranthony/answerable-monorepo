import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { eq, sql } from "drizzle-orm";
import { createAdminFixture } from "./admin.ts";
import { inPlatformWrite } from "./platform-context.ts";
import { createDatabase } from "../db/client.ts";
import { configureRuntimeRole } from "../db/runtime-role.ts";
import {
  auditEvents,
  entitlements,
  oauthClients,
  oauthClientResources,
  oauthResources,
} from "../db/schema/index.ts";
import { createCapability } from "../services/capabilities.ts";
import { hashClientSecret } from "../services/client-secrets.ts";
import { createId } from "../lib/id.ts";
import type { Environment } from "../env.ts";
import type { OperationalMetrics } from "../operations/metrics.ts";

async function worker(environment: Environment) {
  const ready = Promise.withResolvers<string>();
  let receive:
    ((summary: ReturnType<OperationalMetrics["snapshot"]>) => void) | undefined;
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./capacity-worker.ts", import.meta.url).pathname,
    ],
    {
      env: { ...Bun.env, NODE_ENV: "production" },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message) {
        const event = message as {
          stage: string;
          url: string;
          summary: ReturnType<OperationalMetrics["snapshot"]>;
        };
        if (event.stage === "ready") ready.resolve(event.url);
        if (event.stage === "summary") receive?.(event.summary);
      },
    },
  );
  const diagnostics = new Response(child.stderr).text();
  child.stdin.write(JSON.stringify(environment));
  child.stdin.end();
  const timer = setTimeout(
    () => ready.reject(new Error("Capacity worker did not start")),
    15_000,
  );
  try {
    const origin = await ready.promise;
    return {
      origin,
      async snapshot() {
        const response =
          Promise.withResolvers<ReturnType<OperationalMetrics["snapshot"]>>();
        receive = response.resolve;
        child.send("snapshot");
        const timeout = setTimeout(
          () =>
            response.reject(new Error("Capacity worker observation timed out")),
          5000,
        );
        try {
          return await response.promise;
        } finally {
          clearTimeout(timeout);
          receive = undefined;
        }
      },
      async close() {
        child.kill("SIGTERM");
        assert.equal(await child.exited, 0);
        await diagnostics;
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    await diagnostics;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Finite local contention observations through two production-mode Bun processes, not a production capacity benchmark. */
export async function measureMixedCapacity(output: string) {
  const fixture = await createAdminFixture({
    oauthRefreshReuseIntervalSeconds: 10,
  });
  const control = createDatabase(fixture.environment);
  const role = `id_test_capacity_${crypto.randomUUID().replaceAll("-", "")}`;
  const workers: Awaited<ReturnType<typeof worker>>[] = [];
  const results: unknown[] = [];
  const metadata = {
    scope: "synthetic_local_contention",
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    hostMemoryBytes: totalmem(),
    processes: 2,
    poolMaxPerProcess: 4,
    connectionTimeoutMs: 1000,
    statementTimeoutMs: 10000,
    requestMaxPerProcess: 64,
    authenticationHandlersPerPool: 3,
    peakBurstPerProcess: 4,
    network: "loopback HTTP; local PostgreSQL; no ingress",
    authentication:
      "native fixture SSO cookies, client_secret_basic, root commands; NODE_ENV=production workers",
    productionTopologyTrafficRtoRpo: "unknown",
    limitation:
      "Finite observations and maxima, not percentiles, throughput promises or cluster fairness. Fully occupied auth lanes can refuse B OAuth.",
  };
  const save = () =>
    Bun.write(output, JSON.stringify({ metadata, results }, null, 2) + "\n");
  await save();
  try {
    await configureRuntimeRole(fixture.db, role);
    const password = crypto.randomUUID().replaceAll("-", "");
    await fixture.db.execute(
      sql.raw(`alter role "${role}" login password '${password}'`),
    );
    const url = new URL(fixture.environment.databaseUrl);
    url.username = role;
    url.password = password;
    const environment = {
      ...fixture.environment,
      nodeEnv: "production" as const,
      port: 0,
      databaseUrl: url.toString(),
      databasePoolMax: 4,
      operationalLogIntervalMs: 0,
    };
    const secret = crypto.randomUUID();
    const verifier = "v".repeat(64),
      redirect = "https://consumer.example/callback",
      resource = "https://capacity.example/resource";
    await fixture.db.insert(oauthResources).values({
      id: createId(),
      identifier: resource,
      name: "Capacity resource",
      allowedScopes: ["openid", "offline_access", "work:read"],
    });
    const tenants = [
      fixture.principals.tenantAdmin,
      fixture.principals.outsider,
    ];
    for (const [index, tenant] of tenants.entries()) {
      const clientId = `capacity-${index}`;
      await fixture.db.insert(oauthClients).values({
        id: createId(),
        clientId,
        clientSecret: hashClientSecret(secret),
        name: "Capacity client",
        organizationId: tenant.organizationId,
        scopes: ["openid", "offline_access", "work:read"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        redirectUris: [redirect],
        tokenEndpointAuthMethod: "client_secret_basic",
        requirePKCE: true,
      });
      await fixture.db
        .insert(oauthClientResources)
        .values({ id: createId(), clientId, resourceId: resource });
      await inPlatformWrite(fixture.db, async (context) => {
        for (const input of [
          {
            clientId,
            resource: null,
            grantKind: "authorization_code" as const,
            scopes: ["openid", "offline_access"],
          },
          {
            clientId,
            resource,
            grantKind: "authorization_code" as const,
            scopes: ["work:read"],
          },
          {
            clientId,
            resource,
            grantKind: "refresh_token" as const,
            scopes: ["work:read"],
          },
        ])
          await createCapability(context, tenant.organizationId, input);
      });
      await fixture.db.insert(entitlements).values([
        {
          id: createId(),
          organizationId: tenant.organizationId,
          clientId,
          scopes: ["openid", "offline_access"],
        },
        {
          id: createId(),
          organizationId: tenant.organizationId,
          clientId,
          resource,
          scopes: ["work:read"],
        },
      ]);
    }
    for (let i = 0; i < 2; i++) workers.push(await worker(environment));
    async function request(
      index: number,
      path: string,
      init: RequestInit = {},
    ) {
      const start = performance.now();
      const response = await fetch(new URL(path, workers[index]!.origin), {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      return {
        status: response.status,
        ms: performance.now() - start,
        headers: response.headers,
        body:
          text && response.headers.get("content-type")?.includes("json")
            ? JSON.parse(text)
            : text,
      };
    }
    async function code(index: number, tenantIndex: number) {
      const tenant = tenants[tenantIndex]!;
      const headers = {
        Cookie: tenant.cookie,
        Origin: fixture.trustedOrigin,
        "Content-Type": "application/json",
      };
      const query = new URLSearchParams({
        client_id: `capacity-${tenantIndex}`,
        response_type: "code",
        redirect_uri: redirect,
        scope: "openid offline_access work:read",
        resource,
        state: createId(),
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
      });
      const started = await request(index, `/auth/oauth2/authorize?${query}`, {
        headers,
      });
      assert.equal(started.status, 302);
      const selection = new URL(started.headers.get("location")!);
      const selected = await request(index, "/auth/oauth2/continue", {
        method: "POST",
        headers,
        body: JSON.stringify({
          oauth_query: selection.search.slice(1),
          postLogin: true,
          memberId: tenant.memberId,
        }),
      });
      assert.equal(selected.status, 200);
      const consent = new URL(selected.body.url);
      const accepted = await request(index, "/auth/oauth2/consent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          oauth_query: consent.search.slice(1),
          accept: true,
        }),
      });
      assert.equal(accepted.status, 200);
      const value = new URL(accepted.body.url).searchParams.get("code");
      assert.ok(value);
      return value;
    }
    const token = (
      index: number,
      tenantIndex: number,
      body: Record<string, string>,
    ) =>
      request(index, "/auth/oauth2/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`capacity-${tenantIndex}:${secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body),
      });
    const redeem = (index: number, tenantIndex: number, value: string) =>
      token(index, tenantIndex, {
        grant_type: "authorization_code",
        code: value,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource,
      });
    const readB = (index: number) =>
      request(
        index,
        `/api/admin/v1/organizations/${tenants[1]!.organizationId}/groups`,
        { headers: fixture.headers("outsider") },
      );
    const observe = (result: Awaited<ReturnType<typeof request>>) => ({
      status: result.status,
      ms: result.ms,
      retryAfter: result.headers.get("Retry-After"),
      code:
        typeof result.body === "object"
          ? (result.body?.code ?? result.body?.error)
          : undefined,
    });
    const initialB = await redeem(1, 1, await code(1, 1));
    assert.equal(initialB.status, 200);
    const refreshInput = {
      grant_type: "refresh_token",
      refresh_token: initialB.body.refresh_token as string,
      resource,
    };
    const refreshedB = await token(1, 1, refreshInput);
    assert.equal(refreshedB.status, 200);
    const replayedB = await token(0, 1, refreshInput);
    assert.equal(replayedB.status, 200);
    // Native cached replay preserves credentials but recalculates remaining lifetime.
    for (const key of [
      "access_token",
      "refresh_token",
      "id_token",
      "expires_at",
      "scope",
      "token_type",
    ]) {
      assert.ok(
        replayedB.body[key] === refreshedB.body[key],
        "Cached refresh changed its stable response fields",
      );
    }
    assert.ok(replayedB.body.expires_in <= refreshedB.body.expires_in);
    results.push({
      phase: "native_resource_code_refresh_and_cross_process_cached_replay",
      requests: [initialB, refreshedB, replayedB].map(observe),
    });
    await save();
    for (const phase of [
      "user_issuance",
      "tenant_commands",
      "unauthenticated_rejection",
    ] as const) {
      const gate = 892611;
      const aCodes =
        phase === "user_issuance"
          ? await Promise.all(
              [0, 1].map(async (index) => {
                const codes = [];
                for (let n = 0; n < 4; n++) codes.push(await code(index, 0));
                return codes;
              }),
            )
          : [];
      const bCode = phase === "user_issuance" ? await code(1, 1) : "";
      if (phase !== "tenant_commands") {
        const condition =
          phase === "user_issuance"
            ? `NEW.action='oauth.user.issued' AND NEW.organization_id='${tenants[0]!.organizationId}'::uuid`
            : "NEW.action='oauth.token.rejected'";
        await fixture.db.execute(
          sql.raw(
            `create function pause_capacity_audit() returns trigger language plpgsql as $$ begin if ${condition} then perform pg_advisory_xact_lock(${gate}); end if; return NEW; end $$`,
          ),
        );
        await fixture.db.execute(
          sql`create trigger pause_capacity_audit before insert on audit_events for each row execute function pause_capacity_audit()`,
        );
      }
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let blockerPid = 0,
        settled = 0;
      const blocker = fixture.db.transaction(async (tx) => {
        if (phase === "tenant_commands")
          await tx.execute(
            sql`select id from organizations where id=${tenants[0]!.organizationId}::uuid for update`,
          );
        else await tx.execute(sql`select pg_advisory_xact_lock(${gate})`);
        blockerPid = Number(
          (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
        );
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const keys = Array.from({ length: 8 }, () => createId());
      const send = (n: number) => {
        const index = Math.floor(n / 4);
        if (phase === "user_issuance")
          return redeem(index, 0, aCodes[index]![n % 4]!);
        if (phase === "unauthenticated_rejection")
          return request(index, "/auth/oauth2/token", {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from("unknown:wrong").toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              resource,
            }),
          });
        return request(
          index,
          `/api/admin/v1/organizations/${tenants[0]!.organizationId}/groups`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${environment.rootAdminSecret}`,
              "Idempotency-Key": keys[n]!,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              slug: `capacity-command-${n}`,
              name: "Capacity",
            }),
          },
        );
      };
      const pending = Array.from({ length: 8 }, (_, n) =>
        send(n).then((response) => {
          settled++;
          return response;
        }),
      );
      const bReads = [],
        during = [],
        bOAuth = [];
      let blocked = 0;
      try {
        const deadline = Date.now() + 1500;
        do {
          const result = await control.db
            .execute(sql`with recursive waiting as (
            select pid from pg_stat_activity where usename=${role} and ${blockerPid}=any(pg_blocking_pids(pid))
            union select a.pid from pg_stat_activity a join waiting w on w.pid=any(pg_blocking_pids(a.pid)) where a.usename=${role}
          ) select count(*)::int as n from waiting`);
          blocked = Number(result.rows[0]!.n);
          if (blocked + settled === 8) break;
          assert.ok(
            Date.now() < deadline,
            "Work did not reach the controlled database barrier",
          );
          await Bun.sleep(10);
        } while (blocked + settled < 8);
        assert.equal(blocked, phase === "tenant_commands" ? 4 : 6);
        for (let index = 0; index < 2; index++) {
          const read = await readB(index);
          bReads.push(observe(read));
          assert.equal(read.status, 200);
          during.push(await workers[index]!.snapshot());
        }
        if (phase === "user_issuance") {
          const refused = await redeem(1, 1, bCode);
          assert.equal(refused.status, 503);
          bOAuth.push(observe(refused));
        }
      } finally {
        release.resolve();
        await blocker;
        await Promise.allSettled(pending);
        if (phase !== "tenant_commands") {
          await fixture.db.execute(
            sql`drop trigger pause_capacity_audit on audit_events`,
          );
          await fixture.db.execute(sql`drop function pause_capacity_audit()`);
        }
      }
      const responses = await Promise.all(pending),
        recoveries = [];
      const success =
        phase === "tenant_commands"
          ? 201
          : phase === "user_issuance"
            ? 200
            : 401;
      assert.equal(
        responses.filter((response) => response.status === success).length,
        blocked,
      );
      for (const [n, response] of responses.entries()) {
        assert.ok([success, 503].includes(response.status));
        if (response.status === 503) {
          assert.equal(response.headers.get("Retry-After"), "1");
          const recovered = await send(n);
          assert.equal(recovered.status, success);
          recoveries.push(observe(recovered));
          if (phase === "tenant_commands") {
            const replay = await send(n);
            assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
            assert.equal(
              replay.headers.get("Operation-Id"),
              recovered.headers.get("Operation-Id"),
            );
            assert.deepEqual(replay.body, recovered.body);
            const facts = await control.db
              .select()
              .from(auditEvents)
              .where(
                eq(
                  auditEvents.operationId,
                  recovered.headers.get("Operation-Id")!,
                ),
              );
            assert.equal(facts.length, 1);
          }
        }
      }
      if (phase === "user_issuance") {
        const recovered = await redeem(1, 1, bCode);
        assert.equal(recovered.status, 200);
        bOAuth.push(observe(recovered));
      }
      results.push({
        phase,
        blockedDatabaseConnections: blocked,
        requests: responses.map(observe),
        bReads,
        bOAuth,
        recoveries,
        during,
      });
      await save();
    }
    results.push({
      phase: "drained",
      summaries: await Promise.all(workers.map((worker) => worker.snapshot())),
    });
    await save();
    console.log(
      JSON.stringify({
        event: "synthetic_capacity_verified",
        phases: results.length,
        output,
      }),
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await control.close();
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
}
