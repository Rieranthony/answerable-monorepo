import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import type { Database } from "../db/client.ts";
import type { Environment } from "../env.ts";
import {
  adminOperations,
  auditEvents,
  auditEventSubjects,
  oauthClients,
  oauthClientResources,
  oauthConsents,
  oauthResources,
  securityIdentifiers,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

/** Product tombstones and their original receipt survive an actual database restore. */
export async function prepareRestoredDeletion(
  db: Database,
  runtime: Database,
  environment: Environment,
  organizationId: string,
  userId: string,
) {
  const clientId = `restore-deleted-${createId()}`;
  const resource = `https://restore-deleted.example/${createId()}`;
  const clientInstanceId = createId();
  await db.insert(oauthClients).values({
    id: clientInstanceId,
    clientId,
    organizationId,
    clientSecret: "synthetic-deleted-credential",
    redirectUris: [],
  });
  await db
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier: resource,
      name: "Restore deletion",
      classification: "tenant_owned",
      organizationId,
    });
  await db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  await db
    .insert(oauthConsents)
    .values({ id: createId(), clientId, userId, scopes: ["read"] });
  const key = createId();
  const path = `/api/admin/v1/clients/${clientId}?confirm=${clientId}`;
  function app(database: Database) {
    return createApp({
      db: database,
      auth: createAuth(database, environment),
      environment,
    });
  }
  const headers = {
    Authorization: `Bearer ${environment.rootAdminSecret}`,
    "Idempotency-Key": key,
  };
  const removed = await app(runtime).request(path, {
    method: "DELETE",
    headers,
  });
  assert.equal(removed.status, 204);
  const operationId = removed.headers.get("Operation-Id")!;
  async function snapshot(database: Database) {
    const events = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId))
      .orderBy(auditEvents.id);
    return {
      client: await database
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.id, clientInstanceId)),
      links: await database
        .select()
        .from(oauthClientResources)
        .where(eq(oauthClientResources.clientId, clientId)),
      consents: await database
        .select()
        .from(oauthConsents)
        .where(eq(oauthConsents.clientId, clientId)),
      reservation: await database
        .select()
        .from(securityIdentifiers)
        .where(eq(securityIdentifiers.instanceId, clientInstanceId)),
      operations: await database
        .select()
        .from(adminOperations)
        .where(eq(adminOperations.id, operationId)),
      subjects: await database
        .select()
        .from(auditEventSubjects)
        .where(
          inArray(
            auditEventSubjects.eventId,
            events.map((event) => event.id),
          ),
        )
        .orderBy(
          auditEventSubjects.eventId,
          auditEventSubjects.entityType,
          auditEventSubjects.entityId,
          auditEventSubjects.relationship,
        ),
      events,
    };
  }
  const before = await snapshot(db);
  assert.equal(before.client.length, 1);
  assert.ok(before.client[0]!.deletedAt);
  assert.equal(before.client[0]!.disabled, true);
  assert.equal(before.client[0]!.clientSecret, null);
  assert.ok(before.links[0]!.deletedAt);
  assert.ok(before.consents[0]!.deletedAt);
  assert.equal(before.reservation.length, 1);
  assert.equal(before.operations.length, 1);
  assert.ok(
    before.subjects.some(
      (subject) =>
        subject.entityId === userId && subject.relationship === "affected",
    ),
  );
  return async (restoredDb: Database, restoredRuntime: Database) => {
    assert.deepEqual(await snapshot(restoredDb), before);
    assert.equal(
      (
        await app(restoredRuntime).request(
          `/api/admin/v1/clients/${clientId}`,
          { headers },
        )
      ).status,
      404,
    );
    const native = (await createAuth(restoredRuntime, environment).$context)
      .adapter;
    assert.equal(
      await native.findOne({
        model: "oauthClient",
        where: [{ field: "clientId", value: clientId }],
      }),
      null,
    );
    const replay = await app(restoredRuntime).request(path, {
      method: "DELETE",
      headers,
    });
    assert.equal(replay.status, 204);
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.equal(replay.headers.get("Operation-Id"), operationId);
    assert.deepEqual(await snapshot(restoredDb), before);
  };
}
