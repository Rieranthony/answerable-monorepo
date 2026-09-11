import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Executor } from "../db/client.ts";
import {
  adminOperations,
  auditEvents,
  auditEventSubjects,
  members,
  oauthClients,
  securityIdentifiers,
} from "../db/schema/index.ts";

import { setDatabaseScope } from "../db/isolation.ts";

const ids = z.array(z.uuid()).max(1000);
export const recoveryEvidenceSchema = z
  .object({
    version: z.literal(1),
    operations: z
      .array(
        z
          .object({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      )
      .min(1)
      .max(1000),
    revokedMemberIds: ids,
    deletedClientIds: ids,
  })
  .strict();
export type RecoveryEvidence = z.infer<typeof recoveryEvidenceSchema>;

async function receiptDigest(db: Executor, id: string) {
  const [operation] = await db
    .select()
    .from(adminOperations)
    .where(eq(adminOperations.id, id));
  if (!operation) throw new Error("Missing operation");
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, id))
    .orderBy(auditEvents.id);
  if (!events.length) throw new Error("Missing operation evidence");
  const subjects = await db
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
    );
  return createHash("sha256")
    .update(JSON.stringify({ operation, events, subjects }))
    .digest("hex");
}

async function checkBarriers(
  db: Executor,
  evidence: Pick<RecoveryEvidence, "revokedMemberIds" | "deletedClientIds">,
) {
  for (const id of evidence.revokedMemberIds) {
    const [member] = await db
      .select({ status: members.status, revokedAt: members.revokedAt })
      .from(members)
      .where(eq(members.id, id));
    if (member?.status !== "revoked" || !member.revokedAt)
      throw new Error("Missing membership barrier");
  }
  for (const id of evidence.deletedClientIds) {
    const [client] = await db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, id));
    if (!client?.deletedAt || !client.disabled || client.clientSecret !== null)
      throw new Error("Missing client tombstone");
    const [reservation] = await db
      .select()
      .from(securityIdentifiers)
      .where(
        and(
          eq(securityIdentifiers.kind, "client"),
          eq(securityIdentifiers.instanceId, id),
          eq(securityIdentifiers.identifier, client.clientId),
        ),
      );
    if (!reservation) throw new Error("Missing identifier reservation");
  }
}

/** Capture only explicitly listed, committed facts. Caller must independently retain and establish completeness of this evidence. */
export async function captureRecoveryEvidence(
  db: Database,
  input: {
    operationIds: string[];
    revokedMemberIds: string[];
    deletedClientIds: string[];
  },
): Promise<RecoveryEvidence> {
  const parsed = z
    .object({
      operationIds: ids.min(1),
      revokedMemberIds: ids,
      deletedClientIds: ids,
    })
    .strict()
    .parse(input);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`set transaction isolation level repeatable read, read only`,
    );
    await setDatabaseScope(tx, { kind: "platform", access: "read" });
    await checkBarriers(tx, parsed);
    const operations = [];
    for (const id of parsed.operationIds)
      operations.push({ id, sha256: await receiptDigest(tx, id) });
    return {
      version: 1,
      operations,
      revokedMemberIds: parsed.revokedMemberIds,
      deletedClientIds: parsed.deletedClientIds,
    };
  });
}

/** Negative reopening gate, not proof that an external manifest includes every acknowledged change. Never repairs data. */
export async function verifyRecoveryEvidence(db: Database, input: unknown) {
  try {
    const evidence = recoveryEvidenceSchema.parse(input);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`set transaction isolation level repeatable read, read only`,
      );
      await setDatabaseScope(tx, { kind: "platform", access: "read" });
      await checkBarriers(tx, evidence);
      for (const operation of evidence.operations)
        if ((await receiptDigest(tx, operation.id)) !== operation.sha256)
          throw new Error("Changed operation evidence");
    });
    return {
      operations: evidence.operations.length,
      revokedMembers: evidence.revokedMemberIds.length,
      deletedClients: evidence.deletedClientIds.length,
    };
  } catch {
    throw new Error("Recovery evidence does not match; keep traffic closed");
  }
}
