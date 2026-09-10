type Tail<T extends unknown[]> = T extends [unknown, ...infer A] ? A : never;
import * as queries from "../db/queries/groups.ts";
export type * from "../db/queries/groups.ts";
import type { Database, Executor } from "../db/client.ts";
import { inTenantRead } from "./tenant-command.ts";
/** Test adapters exercise production query authority while preserving fixture call sites. */
import { inPlatformWrite } from "./platform-context.ts";
export const createGroup = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.createGroup>>
) => inPlatformWrite(db, (context) => queries.createGroup(context, ...args));
export const updateGroup = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.updateGroup>>
) => inPlatformWrite(db, (context) => queries.updateGroup(context, ...args));
export const setGroupStatus = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.setGroupStatus>>
) => inPlatformWrite(db, (context) => queries.setGroupStatus(context, ...args));
export const deleteGroup = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.deleteGroup>>
) => inPlatformWrite(db, (context) => queries.deleteGroup(context, ...args));
export const upsertGroupMember = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.upsertGroupMember>>
) =>
  inPlatformWrite(db, (context) => queries.upsertGroupMember(context, ...args));
export const removeGroupMember = (
  db: Database,
  ...args: Tail<Parameters<typeof queries.removeGroupMember>>
) =>
  inPlatformWrite(db, (context) => queries.removeGroupMember(context, ...args));
export const listGroups = (
  db: Database,
  organizationId: string,
  ...args: Tail<Parameters<typeof queries.listGroups>>
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queries.listGroups(context, ...args),
  );
export const findGroup = (
  db: Database,
  organizationId: string,
  groupId: string,
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queries.findGroup(context, groupId),
  );

export const listGroupMembers = (
  db: Database,
  organizationId: string,
  ...args: Tail<Parameters<typeof queries.listGroupMembers>>
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queries.listGroupMembers(context, ...args),
  );
export const findGroupMember = (
  db: Database,
  organizationId: string,
  groupId: string,
  memberId: string,
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    queries.findGroupMember(context, groupId, memberId),
  );

import { groupMembers } from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
/** Fixture insertion only; production membership writes go through the assignment command. */
export async function addGroupMember(
  db: Executor,
  input: { organizationId: string; groupId: string; memberId: string },
) {
  const [row] = await db
    .insert(groupMembers)
    .values({ ...input, id: createId() })
    .returning();
  return row!;
}
