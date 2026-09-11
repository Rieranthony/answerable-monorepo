import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import type { Database } from "../db/client.ts";
import type { Environment } from "../env.ts";
import { members, oauthClients, users } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import {
  captureRecoveryEvidence,
  verifyRecoveryEvidence,
} from "../operations/recovery.ts";

/** The source remains available in this synthetic scenario. A second complete dump is the reconciliation source, never reconstructed rows. */
export async function prepareRecoveryGap(
  owner: Database,
  environment: Environment,
  organizationA: string,
  organizationB: string,
) {
  const userId = createId(),
    memberA = createId(),
    memberB = createId();
  await owner
    .insert(users)
    .values({
      id: userId,
      name: "Recovery gap",
      email: `${userId}@example.invalid`,
      status: "active",
    });
  await owner.insert(members).values([
    { id: memberA, userId, organizationId: organizationA },
    { id: memberB, userId, organizationId: organizationB },
  ]);
  const clientId = `post-snapshot-${createId()}`;
  const commands = [
    {
      path: `/organizations/${organizationA}/members/${memberA}`,
      method: "DELETE",
      body: undefined as unknown,
      status: 204,
      key: createId(),
    },
    {
      path: "/clients",
      method: "POST",
      body: {
        clientId,
        name: "Recovery gap client",
        organizationId: organizationA,
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        redirectUris: [],
        clientCredentialsScopes: ["read"],
      },
      status: 201,
      key: createId(),
    },
    {
      path: `/clients/${clientId}/rotate-secret`,
      method: "POST",
      body: undefined,
      status: 200,
      key: createId(),
    },
    {
      path: `/clients/${clientId}?confirm=${clientId}`,
      method: "DELETE",
      body: undefined,
      status: 204,
      key: createId(),
    },
  ];
  const app = (db: Database) =>
    createApp({ db, environment, auth: createAuth(db, environment) });
  const send = (
    application: ReturnType<typeof app>,
    command: (typeof commands)[number],
  ) =>
    application.request(`/api/admin/v1${command.path}`, {
      method: command.method,
      headers: {
        Authorization: `Bearer ${environment.rootAdminSecret}`,
        "Idempotency-Key": command.key,
        "Content-Type": "application/json",
      },
      body:
        command.body === undefined ? undefined : JSON.stringify(command.body),
    });
  return {
    userId,
    async commit(db: Database, runtime: Database) {
      const application = app(runtime);
      const responses: { id: string; body: string }[] = [];
      for (const command of commands) {
        const response = await send(application, command);
        assert.equal(response.status, command.status);
        responses.push({
          id: response.headers.get("Operation-Id")!,
          body: await response.text(),
        });
      }
      const [client] = await db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId));
      assert.ok(client);
      const evidence = await captureRecoveryEvidence(db, {
        operationIds: responses.map((response) => response.id),
        revokedMemberIds: [memberA],
        deletedClientIds: [client.id],
      });
      return {
        evidence,
        async verifyOld(database: Database, runtime: Database) {
          const application = app(runtime);
          let open = false;
          const listener = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) =>
              open
                ? application.fetch(request)
                : new Response("Recovery closed", { status: 503 }),
          });
          try {
            await assert.rejects(async () => {
              await verifyRecoveryEvidence(database, evidence);
              open = true;
            }, /keep traffic closed/);
            const response = await fetch(
              new URL(`/api/admin/v1${commands[1]!.path}`, listener.url),
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${environment.rootAdminSecret}`,
                  "Idempotency-Key": commands[1]!.key,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(commands[1]!.body),
              },
            );
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("Operation-Id"), null);
            await response.arrayBuffer();
            const [oldA] = await database
              .select()
              .from(members)
              .where(eq(members.id, memberA));
            assert.equal(oldA?.status, "active");
            assert.equal(
              (
                await database
                  .select()
                  .from(oauthClients)
                  .where(eq(oauthClients.clientId, clientId))
              ).length,
              0,
            );
          } finally {
            listener.stop(true);
          }
        },
        async verifyRecovered(database: Database, runtime: Database) {
          assert.deepEqual(await verifyRecoveryEvidence(database, evidence), {
            operations: 4,
            revokedMembers: 1,
            deletedClients: 1,
          });
          const application = app(runtime);
          const listener = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: application.fetch,
          });
          try {
            const ready = await fetch(new URL("/readyz", listener.url));
            assert.equal(ready.status, 200);
            await ready.arrayBuffer();
            for (const [index, command] of commands.entries()) {
              const response = await send(application, command);
              assert.equal(response.status, command.status);
              assert.equal(
                response.headers.get("Idempotency-Replayed"),
                "true",
              );
              assert.equal(
                response.headers.get("Operation-Id"),
                responses[index]!.id,
              );
              assert.equal(await response.text(), responses[index]!.body);
            }
            await verifyRecoveryEvidence(database, evidence);
            const [b] = await database
              .select()
              .from(members)
              .where(eq(members.id, memberB));
            assert.equal(b?.status, "active");
            assert.equal(b?.userId, userId);
          } finally {
            listener.stop(true);
          }
        },
      };
    },
  };
}
