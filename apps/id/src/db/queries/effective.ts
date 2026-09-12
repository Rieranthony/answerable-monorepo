import type { Executor } from "../client.ts";
import {
  entitlements,
  members,
  groupMembers,
  groups,
} from "../schema/index.ts";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export function isEffective(table: {
  validFrom: PgColumn;
  validUntil: PgColumn;
  status?: PgColumn;
  deletedAt?: PgColumn;
}): SQL {
  // Evaluate at this statement, not the start of a transaction that may have waited.
  const window = sql`(${table.validFrom} is null or ${table.validFrom} <= statement_timestamp()) and (${table.validUntil} is null or ${table.validUntil} > statement_timestamp())`;

  // Parenthesised so callers can negate or combine it without precedence
  // surprises (`not (a and b)`, `x or (a and b)`).
  const present = table.deletedAt ? sql`${table.deletedAt} is null` : sql`true`;
  return table.status
    ? sql`(${present} and ${table.status} = 'active' and ${window})`
    : sql`(${present} and ${window})`;
}

export function matchingEntitlements(executor: Executor) {
  return and(
    eq(entitlements.organizationId, members.organizationId),
    isEffective(entitlements),
    or(
      and(isNull(entitlements.memberId), isNull(entitlements.groupId)),
      eq(entitlements.memberId, members.id),
      inArray(
        entitlements.groupId,
        executor
          .select({ groupId: groupMembers.groupId })
          .from(groupMembers)
          .innerJoin(groups, eq(groups.id, groupMembers.groupId))
          .where(
            and(
              eq(groupMembers.memberId, members.id),
              eq(groups.status, "active"),
              sql`${groups.deletedAt} is null`,
              isEffective(groupMembers),
            ),
          ),
      ),
    ),
  );
}
