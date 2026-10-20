import { type TenantReadContext } from "./tenant-context.ts";
import { userExists } from "../db/queries/users.ts";
import { type PlatformReadContext } from "./platform-context.ts";
import * as queries from "../db/queries/audit.ts";
import { organizationExistsForHistory } from "../db/queries/organizations.ts";
import type { Executor } from "../db/client.ts";
import type { PageQuery } from "../http/pagination.ts";
import { found } from "../http/problem.ts";
import type { Actor } from "./actor.ts";

/** A status command's audit action. A command that changed nothing records
 * none: its operation receipt (outcome noop) is the record. */
export function statusAction(
  entity: "domain" | "entitlement" | "group",
  status: "active" | "disabled",
): queries.AuditAction {
  return `${entity}.${status === "active" ? "enabled" : "disabled"}`;
}

const bookkeeping = new Set(["live", "createdAt", "updatedAt"]);

/** A row as audit evidence: the row without the columns that only keep books. */
export type Evidence<Row> = Omit<Row, "live" | "createdAt" | "updatedAt">;

/** Project a row to audit evidence: every column but `live`, `createdAt` and
 * `updatedAt`, so a command's before and after carry the same keys. */
export function evidence<Row extends object>(row: Row): Evidence<Row> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !bookkeeping.has(key)),
  ) as Evidence<Row>;
}

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
