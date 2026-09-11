import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createAdminFixture } from "../__tests__/admin.ts";
import { prepareRecoveryGap } from "../__tests__/restore-reconciliation.ts";
import { captureRecoveryEvidence, verifyRecoveryEvidence } from "./recovery.ts";
import { createId } from "../lib/id.ts";
import {
  auditEvents,
  members,
  oauthClients,
  securityIdentifiers,
} from "../db/schema/index.ts";

test("recovery refuses missing, altered and incomplete listed facts and never repairs them", async () => {
  const fixture = await createAdminFixture();
  try {
    const gap = await prepareRecoveryGap(
      fixture.db,
      fixture.environment,
      fixture.tenant.organizationId,
      fixture.outsider.organizationId,
    );
    await expect(
      captureRecoveryEvidence(fixture.db, {
        operationIds: [createId()],
        revokedMemberIds: [],
        deletedClientIds: [],
      }),
    ).rejects.toThrow("Missing operation");
    const committed = await gap.commit(fixture.db, fixture.db);
    await committed.verifyRecovered(fixture.db, fixture.db);
    for (const evidence of [
      {},
      { ...committed.evidence, operations: [] },
      {
        ...committed.evidence,
        operations: [{ id: createId(), sha256: "0".repeat(64) }],
      },
      {
        ...committed.evidence,
        operations: [
          { ...committed.evidence.operations[0], sha256: "0".repeat(64) },
        ],
      },
      {
        ...committed.evidence,
        revokedMemberIds: [fixture.principals.tenantAdmin.memberId],
      },
      { ...committed.evidence, deletedClientIds: [createId()] },
    ])
      await expect(
        verifyRecoveryEvidence(fixture.db, evidence),
      ).rejects.toThrow("keep traffic closed");
    const operationId = committed.evidence.operations[0]!.id;
    expect(
      (
        await fixture.db
          .select()
          .from(members)
          .where(eq(members.id, committed.evidence.revokedMemberIds[0]!))
      )[0]!.status,
    ).toBe("revoked");
    const clientId = committed.evidence.deletedClientIds[0]!;
    expect(
      (
        await fixture.db
          .select()
          .from(oauthClients)
          .where(eq(oauthClients.id, clientId))
      )[0]!.clientSecret,
    ).toBeNull();
    await fixture.db.transaction(async (tx) => {
      // Test-owner corruption only: ordinary runtime/owner writes cannot delete permanent reservations.
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .delete(securityIdentifiers)
        .where(eq(securityIdentifiers.instanceId, clientId));
    });
    await expect(
      verifyRecoveryEvidence(fixture.db, committed.evidence),
    ).rejects.toThrow("keep traffic closed");
    // This fixture will be reset by the next test; remove only the already verified listed audit to exercise refusal.
    await fixture.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .delete(auditEvents)
        .where(eq(auditEvents.operationId, operationId));
    });
    await expect(
      verifyRecoveryEvidence(fixture.db, {
        ...committed.evidence,
        deletedClientIds: [],
      }),
    ).rejects.toThrow("keep traffic closed");
  } finally {
    await fixture.close();
  }
});
