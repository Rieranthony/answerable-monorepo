import { createId } from "../../lib/id.ts";
import type { Database } from "../client.ts";
import { groupMembers, groups } from "../schema/index.ts";

export type CreateGroupInput = {
  organizationId: string;
  slug: string;
  name: string;
  /** Set when the group mirrors an upstream directory group. */
  externalId?: string;
};

export async function createGroup(db: Database, input: CreateGroupInput) {
  const [group] = await db
    .insert(groups)
    .values({ id: createId(), ...input })
    .returning();

  return group!;
}

export async function addGroupMember(
  db: Database,
  input: { organizationId: string; groupId: string; memberId: string },
) {
  const [membership] = await db.insert(groupMembers).values(input).returning();

  return membership!;
}
