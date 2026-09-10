import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { recordAuditEvent } from "../db/queries/audit.ts";
import {
  groups,
  oauthResources,
  organizations,
  systemBindings,
} from "../db/schema/index.ts";
import { ProblemError } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

type BindingInput = {
  organizationId: string;
  resourceId: string;
  groupId: string;
  resourceIdentifier: string;
};

/** Offline migration command: IDs must come from the operator's reviewed inventory. */
export function bindExistingSystem(
  db: Database,
  actor: Actor,
  input: BindingInput,
) {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('answerable:bootstrap'))`,
    );
    const [existing] = await tx.select().from(systemBindings);
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, input.organizationId));
    const [resource] = await tx
      .select()
      .from(oauthResources)
      .where(eq(oauthResources.id, input.resourceId));
    const [group] = await tx
      .select()
      .from(groups)
      .where(eq(groups.id, input.groupId));
    if (
      !organization ||
      !resource ||
      !group ||
      group.organizationId !== organization.id ||
      resource.identifier !== input.resourceIdentifier ||
      (existing &&
        (existing.organizationId !== input.organizationId ||
          existing.resourceId !== input.resourceId ||
          existing.groupId !== input.groupId))
    )
      throw new ProblemError(
        409,
        "system_binding_conflict",
        "System identity conflict",
      );
    if (!existing)
      await tx.insert(systemBindings).values({
        name: "platform",
        organizationId: input.organizationId,
        resourceId: input.resourceId,
        groupId: input.groupId,
      });
    await recordAuditEvent(tx, {
      ...actor,
      organizationId: input.organizationId,
      targetType: "organization",
      targetId: input.organizationId,
      action: existing ? "system.binding_verified" : "system.bound",
      outcome: "success",
      data: { ...input, changed: !existing },
    });
    return {
      organizationId: input.organizationId,
      resourceId: input.resourceId,
      groupId: input.groupId,
      created: !existing,
    };
  });
}
