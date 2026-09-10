import {
  requirePlatformReadContext,
  type PlatformReadContext,
} from "../../services/platform-context.ts";
import {
  requireTenantDirectoryContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import {
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  max,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Executor } from "../client.ts";
import {
  auditEvents,
  entitlements,
  groups,
  members,
  oauthClients,
  oauthResources,
  organizationDomains,
  organizations,
  sessions,
  ssoProviders,
  users,
  systemBindings,
} from "../schema/index.ts";

const filtered = (condition: SQL) =>
  sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
const statuses = (column: PgColumn) => ({
  active: filtered(eq(column, "active")),
  disabled: filtered(eq(column, "disabled")),
});
const userStatuses = () => ({
  inert: filtered(eq(users.status, "inert")),
  ...statuses(users.status),
});

export async function platformSummary(
  context: PlatformReadContext,
  { now }: { now: Date },
) {
  const { tx: executor } = requirePlatformReadContext(context);
  const [
    platformRows,
    [organizationCounts],
    [userCounts],
    [clients],
    [resources],
    [sessionCounts],
    [denied],
  ] = await Promise.all([
    executor
      .select({
        organizationId: systemBindings.organizationId,
        groupId: systemBindings.groupId,
      })
      .from(systemBindings),
    executor.select(statuses(organizations.status)).from(organizations),
    executor.select(userStatuses()).from(users),
    executor
      .select({
        total: count(),
        disabled: filtered(eq(oauthClients.disabled, true)),
        unowned: filtered(isNull(oauthClients.organizationId)),
      })
      .from(oauthClients),
    executor
      .select({
        total: count(),
        disabled: filtered(eq(oauthResources.disabled, true)),
      })
      .from(oauthResources),
    executor
      .select({ active: filtered(gt(sessions.expiresAt, now)) })
      .from(sessions),
    executor
      .select({ total: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "admin.denied"),
          gte(auditEvents.occurredAt, new Date(now.getTime() - 86_400_000)),
        ),
      ),
  ]);
  const platform = platformRows.at(0);
  return {
    platform: {
      organizationId: platform?.organizationId ?? null,
      groupId: platform?.groupId ?? null,
    },
    organizations: organizationCounts!,
    users: userCounts!,
    clients: clients!,
    resources: resources!,
    sessions: sessionCounts!,
    denied24h: denied!.total,
  };
}

export async function organizationSummary(
  context: TenantReadContext<"directory">,
  { now }: { now: Date },
) {
  const { tx: executor, organizationId } =
    requireTenantDirectoryContext(context);
  // Same inclusive start / exclusive end as isEffective, at the caller's instant.
  const effective = sql`${members.status} = 'active' and (${members.validFrom} is null or ${members.validFrom} <= ${now}) and (${members.validUntil} is null or ${members.validUntil} > ${now})`;
  const [
    organizationRows,
    [domains],
    providerRows,
    [memberCounts],
    [groupCounts],
    targets,
    [clients],
  ] = await Promise.all([
    executor
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId)),
    executor
      .select(statuses(organizationDomains.status))
      .from(organizationDomains)
      .where(eq(organizationDomains.organizationId, organizationId)),
    executor
      .select({ issuer: ssoProviders.issuer })
      .from(ssoProviders)
      .where(eq(ssoProviders.organizationId, organizationId)),
    executor
      .select({
        total: count(),
        effective: filtered(effective),
        ...userStatuses(),
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, organizationId)),
    executor
      .select(statuses(groups.status))
      .from(groups)
      .where(eq(groups.organizationId, organizationId)),
    executor
      .select({
        clientId: entitlements.clientId,
        resource: entitlements.resource,
        rows: count(),
        ...statuses(entitlements.status),
      })
      .from(entitlements)
      .where(eq(entitlements.organizationId, organizationId))
      .groupBy(entitlements.clientId, entitlements.resource)
      .orderBy(entitlements.clientId, entitlements.resource),
    executor
      .select({ owned: count() })
      .from(oauthClients)
      .where(eq(oauthClients.organizationId, organizationId)),
  ]);
  const { total, effective: effectiveCount, ...byStatus } = memberCounts!;
  return {
    organization: organizationRows.at(0) ?? null,
    domains: domains!,
    provider: providerRows.at(0) ?? null,
    members: { total, effective: effectiveCount, byStatus },
    groups: groupCounts!,
    entitlements: {
      active: targets.reduce((sum, row) => sum + row.active, 0),
      disabled: targets.reduce((sum, row) => sum + row.disabled, 0),
      targets: targets.map((row) => {
        if (row.clientId !== null && row.resource !== null)
          return {
            kind: "client_resource" as const,
            id: row.clientId,
            resource: row.resource,
            rows: row.rows,
          };
        return {
          kind:
            row.clientId === null ? ("resource" as const) : ("client" as const),
          id: row.clientId ?? row.resource!,
          rows: row.rows,
        };
      }),
    },
    clients: clients!,
  };
}

export async function platformSignInStats(
  context: PlatformReadContext,
  options: { since: Date },
) {
  const { tx } = requirePlatformReadContext(context);
  return signInStats(tx, options);
}

export async function organizationSignInStats(
  context: TenantReadContext<"directory">,
  { since }: { since: Date },
) {
  const { tx, organizationId } = requireTenantDirectoryContext(context);
  return signInStats(tx, { since, organizationId });
}

async function signInStats(
  executor: Executor,
  { organizationId, since }: { organizationId?: string; since: Date },
) {
  const rows = await executor
    .select({
      action: auditEvents.action,
      reason: auditEvents.reason,
      total: count(),
      last: max(auditEvents.occurredAt),
    })
    .from(auditEvents)
    .where(
      and(
        gte(auditEvents.occurredAt, since),
        organizationId === undefined
          ? undefined
          : eq(auditEvents.organizationId, organizationId),
        inArray(auditEvents.action, [
          "auth.signin.succeeded",
          "auth.signin.rejected",
        ]),
      ),
    )
    .groupBy(auditEvents.action, auditEvents.reason);
  let succeeded = 0;
  let rejected = 0;
  let lastSucceededAt: Date | null = null;
  const reasons: [string, number][] = [];
  for (const row of rows) {
    if (row.action === "auth.signin.succeeded") {
      succeeded += row.total;
      if (row.last && (!lastSucceededAt || row.last > lastSucceededAt))
        lastSucceededAt = row.last;
    } else {
      rejected += row.total;
      if (row.reason !== null) reasons.push([row.reason, row.total]);
    }
  }
  return {
    succeeded,
    rejected,
    rejectedByReason: Object.fromEntries(reasons),
    lastSucceededAt,
  };
}
