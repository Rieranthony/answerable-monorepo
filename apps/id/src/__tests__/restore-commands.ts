import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../app.ts";
import { createAuth } from "../auth.ts";
import type { Database } from "../db/client.ts";
import type { Environment } from "../env.ts";
import {
  adminOperations,
  adminOperationResults,
  auditEvents,
  auditEventSubjects,
  securityIdentifiers,
  grantContexts,
  members,
  oauthClients,
  organizations,
  sessions,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";

/** Real HTTP commands around a PostgreSQL snapshot, with no synthetic journal. */
export async function prepareRestoredCommands(
  db: Database,
  runtime: Database,
  environment: Environment,
  input: {
    organizationId: string;
    otherOrganizationId: string;
    userId: string;
    callbackURL: string;
  },
) {
  const clientId = `restore-client-${createId()}`;
  const createKey = createId(),
    rotateKey = createId(),
    removeKey = createId();
  const createInput = {
    clientId,
    name: "Restore client",
    organizationId: input.organizationId,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
    redirectUris: [input.callbackURL],
    scopes: ["read"],
    clientCredentialsScopes: ["read"],
  };
  function request(
    database: Database,
    config: Environment,
    path: string,
    key: string,
    body?: unknown,
    method = "POST",
    bearer = environment.rootAdminSecret,
  ) {
    return createApp({
      auth: createAuth(database, config),
      db: database,
      environment: config,
    }).request(`/api/admin/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Idempotency-Key": key,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const created = await request(
    runtime,
    environment,
    "/clients",
    createKey,
    createInput,
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  const rotatePath = `/clients/${clientId}/rotate-secret`;
  const rotated = await request(runtime, environment, rotatePath, rotateKey);
  assert.equal(rotated.status, 200);
  const rotatedBody = (await rotated.json()) as { clientSecret: string };
  assert.notEqual(rotatedBody.clientSecret, createdBody.clientSecret);
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  assert.ok(client);
  await db.insert(organizations).values({
    id: input.otherOrganizationId,
    slug: `restore-b-${input.otherOrganizationId}`,
    name: "Restore B",
  });
  const memberB = createId();
  await db.insert(members).values({
    id: memberB,
    organizationId: input.otherOrganizationId,
    userId: input.userId,
  });
  const [memberA] = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.organizationId, input.organizationId),
        eq(members.userId, input.userId),
      ),
    );
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, input.userId));
  assert.ok(memberA && session);
  const grantIds = [createId(), createId()];
  await db.insert(grantContexts).values(
    [memberA.id, memberB].map((memberId, index) => ({
      id: grantIds[index]!,
      memberId,
      organizationId: index ? input.otherOrganizationId : input.organizationId,
      userId: input.userId,
      clientInstanceId: client.id,
      authenticationSessionId: session.id,
      authTime: session.createdAt,
      requestedScopes: ["read"],
      expiresAt: new Date(Date.now() + 3_600_000),
    })),
  );
  const removePath = `/organizations/${input.otherOrganizationId}/members/${memberB}`;
  const removed = await request(
    runtime,
    environment,
    removePath,
    removeKey,
    undefined,
    "DELETE",
  );
  assert.equal(removed.status, 204);
  const operationIds = [created, rotated, removed].map((response) => {
    const id = response.headers.get("Operation-Id");
    assert.ok(id);
    return id;
  });
  async function snapshot(database: Database) {
    const audits = await database
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.operationId, operationIds))
      .orderBy(auditEvents.id);
    return {
      identifiers: await database
        .select()
        .from(securityIdentifiers)
        .where(eq(securityIdentifiers.instanceId, client!.id)),
      subjects: await database
        .select()
        .from(auditEventSubjects)
        .where(
          inArray(
            auditEventSubjects.eventId,
            audits.map((event) => event.id),
          ),
        )
        .orderBy(
          auditEventSubjects.eventId,
          auditEventSubjects.entityType,
          auditEventSubjects.entityId,
          auditEventSubjects.relationship,
        ),
      client: await database
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.id, client!.id)),
      memberships: await database
        .select()
        .from(members)
        .where(inArray(members.id, [memberA!.id, memberB]))
        .orderBy(members.id),
      grants: await database
        .select()
        .from(grantContexts)
        .where(inArray(grantContexts.id, grantIds))
        .orderBy(grantContexts.id),
      operations: await database
        .select()
        .from(adminOperations)
        .where(inArray(adminOperations.id, operationIds))
        .orderBy(adminOperations.id),
      results: await database
        .select()
        .from(adminOperationResults)
        .where(inArray(adminOperationResults.operationId, operationIds))
        .orderBy(adminOperationResults.operationId),
      audits,
    };
  }
  const before = await snapshot(db);
  assert.equal(before.operations.length, 3);
  assert.equal(before.identifiers.length, 1);
  assert.ok(
    before.subjects.some((subject) => subject.entityId === input.userId),
  );
  assert.equal(
    before.memberships.find((row) => row.id === memberB)?.status,
    "revoked",
  );
  assert.equal(
    before.memberships.find((row) => row.id === memberA.id)?.status,
    "active",
  );
  assert.ok(before.grants.find((row) => row.id === grantIds[1])?.revokedAt);
  assert.equal(
    before.grants.find((row) => row.id === grantIds[0])?.revokedAt,
    null,
  );
  assert.ok(before.audits.length >= 3);
  assert.ok(!JSON.stringify(before).includes(rotatedBody.clientSecret));
  const nextReplayKey = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  const recoveryEnvironment = {
    ...environment,
    operationReplay: {
      activeKeyId: "next",
      keys: { ...environment.operationReplay!.keys, next: nextReplayKey },
    },
  };
  return async (restoredDb: Database, restoredRuntime: Database) => {
    assert.deepEqual(await snapshot(restoredDb), before);
    for (const command of [
      {
        path: "/clients",
        key: createKey,
        body: createInput,
        status: 201,
        response: createdBody,
        operation: operationIds[0],
        method: "POST",
      },
      {
        path: rotatePath,
        key: rotateKey,
        status: 200,
        response: rotatedBody,
        operation: operationIds[1],
        method: "POST",
      },
      {
        path: removePath,
        key: removeKey,
        status: 204,
        operation: operationIds[2],
        method: "DELETE",
      },
    ]) {
      const result = await request(
        restoredRuntime,
        recoveryEnvironment,
        command.path,
        command.key,
        command.body,
        command.method,
      );
      assert.equal(result.status, command.status);
      assert.equal(result.headers.get("Idempotency-Replayed"), "true");
      assert.equal(result.headers.get("Operation-Id"), command.operation);
      if (command.response)
        assert.deepEqual(await result.json(), command.response);
    }
    const changed = await request(
      restoredRuntime,
      recoveryEnvironment,
      "/clients",
      createKey,
      { ...createInput, name: "Different input" },
    );
    assert.equal(changed.status, 409);
    assert.equal(
      ((await changed.json()) as { code: string }).code,
      "idempotency_key_reused",
    );
    const denied = await request(
      restoredRuntime,
      recoveryEnvironment,
      rotatePath,
      rotateKey,
      undefined,
      "POST",
      "not-the-authorised-root",
    );
    assert.equal(denied.status, 401);
    for (const operationReplay of [
      undefined,
      { activeKeyId: "next", keys: { next: nextReplayKey } },
    ]) {
      const unavailable = await request(
        restoredRuntime,
        { ...environment, operationReplay },
        rotatePath,
        rotateKey,
      );
      assert.equal(unavailable.status, 503);
      assert.equal(
        ((await unavailable.json()) as { code: string }).code,
        "operation_replay_unavailable",
      );
    }
    const recovered = await request(
      restoredRuntime,
      recoveryEnvironment,
      rotatePath,
      rotateKey,
    );
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), rotatedBody);
    assert.deepEqual(await snapshot(restoredDb), before);
    await restoredDb
      .delete(adminOperationResults)
      .where(eq(adminOperationResults.operationId, operationIds[1]!));
    const expired = await request(
      restoredRuntime,
      recoveryEnvironment,
      rotatePath,
      rotateKey,
    );
    assert.equal(expired.status, 410);
    assert.equal(
      ((await expired.json()) as { code: string }).code,
      "operation_result_expired",
    );
    assert.deepEqual(await snapshot(restoredDb), {
      ...before,
      results: before.results.filter(
        (row) => row.operationId !== operationIds[1],
      ),
    });
  };
}
