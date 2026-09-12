import type { Executor } from "../db/client.ts";
import * as queries from "../db/queries/groups.ts";
import { bindQuery, bindTenantQuery } from "./bind-query.ts";
export type * from "../db/queries/groups.ts";
/** Test adapters exercise production query authority while preserving fixture call sites. */
import { inPlatformWrite } from "./platform-context.ts";
export const createGroup = bindQuery(inPlatformWrite)(queries.createGroup);
export const updateGroup = bindQuery(inPlatformWrite)(queries.updateGroup);
export const setGroupStatus = bindQuery(inPlatformWrite)(
  queries.setGroupStatus,
);
export const deleteGroup = bindQuery(inPlatformWrite)(queries.deleteGroup);
export const upsertGroupMember = bindQuery(inPlatformWrite)(
  queries.upsertGroupMember,
);
export const removeGroupMember = bindQuery(inPlatformWrite)(
  queries.removeGroupMember,
);
export const listGroups = bindTenantQuery("directory", queries.listGroups);
export const findGroup = bindTenantQuery("directory", queries.findGroup);

export const listGroupMembers = bindTenantQuery(
  "directory",
  queries.listGroupMembers,
);
export const findGroupMember = bindTenantQuery(
  "directory",
  queries.findGroupMember,
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
