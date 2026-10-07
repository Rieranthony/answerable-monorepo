import { type TenantReadContext } from "./tenant-context.ts";
import { userExists } from "../db/queries/users.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import * as queries from "../db/queries/audit.ts";
import { organizationExistsForHistory } from "../db/queries/organizations.ts";
import type { Executor } from "../db/client.ts";
import type { PageQuery } from "../http/pagination.ts";
import { found } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

/** Record a command's successful effect as the command's actor. */
export function recordCommandEvent(
  context: { tx: Executor; actor: Readonly<Actor> },
  event: Pick<
    queries.AuditEventInput,
    "organizationId" | "targetType" | "targetId" | "action" | "data"
  >,
) {
  return queries.recordAuditEvent(context.tx, {
    ...context.actor,
    ...event,
    outcome: "success",
  });
}

export async function listOrganizationAuditEvents(
  context: TenantReadContext<"history">,
  filters: Omit<queries.AuditEventFilters, "organizationId">,
  page: PageQuery,
) {
  // A live organisation, or retained history of an erased one.
  found(
    (await organizationExistsForHistory(context)) ||
      (await queries.listOrganizationAuditEvents(context, {}, { limit: 1 }))
        .items.length,
    "Organisation not found",
  );
  return queries.listOrganizationAuditEvents(context, filters, page);
}

export async function listUserAuditEvents(
  context: PlatformReadContext,
  userId: string,
  filters: Pick<
    queries.AuditEventFilters,
    "action" | "outcome" | "from" | "to"
  >,
  page: PageQuery,
) {
  found(
    (await userExists(context, userId)) ||
      (await queries.listUserAuditEvents(context, userId, {}, { limit: 1 }))
        .items.length,
    "User not found",
  );
  return queries.listUserAuditEvents(context, userId, filters, page);
}
