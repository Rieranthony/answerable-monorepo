import {
  requirePlatformWriteContext,
  type PlatformWriteContext,
} from "../../services/platform-context.ts";
import {
  requireTenantDirectoryContext,
  requireTenantMemberAccessContext,
  type TenantReadContext,
} from "../../services/tenant-context.ts";
import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import { and, desc, eq } from "drizzle-orm";

import { createId } from "../../lib/id.ts";
import { organizationDomains, organizations } from "../schema/index.ts";

const normalizeDomain = (domain: string) => domain.trim().toLowerCase();

export async function createOrganizationDomain(
  context: PlatformWriteContext,
  input: { organizationId: string; domain: string },
) {
  const { tx: db } = requirePlatformWriteContext(context);
  const [domain] = await db
    .insert(organizationDomains)
    .values({
      id: createId(),
      organizationId: input.organizationId,
      domain: normalizeDomain(input.domain),
    })
    .returning();

  return domain!;
}

/** Whether this tenant currently accepts the domain; never returns a foreign identity. */
export async function organizationAcceptsDomain(
  context: TenantReadContext<"memberAccess">,
  domain: string,
) {
  const { tx: db, organizationId } = requireTenantMemberAccessContext(context);
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizationDomains.organizationId, organizations.id),
    )
    .where(
      and(
        eq(organizationDomains.domain, normalizeDomain(domain)),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);

  return organization !== undefined;
}

export type DomainQuery = PageQuery & { status?: LifecycleStatus };

export function listOrganizationDomains(
  context: TenantReadContext<"directory">,
  query: DomainQuery,
) {
  const { tx: executor, organizationId } =
    requireTenantDirectoryContext(context);
  return executor
    .select()
    .from(organizationDomains)
    .where(
      and(
        eq(organizationDomains.organizationId, organizationId),
        query.status === undefined
          ? undefined
          : eq(organizationDomains.status, query.status),
        beforeCursor(organizationDomains.id, query.cursor),
      ),
    )
    .orderBy(desc(organizationDomains.id))
    .limit(query.limit + 1);
}

export async function findOrganizationDomainForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const query = executor
    .select()
    .from(organizationDomains)
    .where(
      and(
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    );
  const [row] = await query.for("update");
  return row ?? null;
}

export async function setOrganizationDomainStatus(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  const [row] = await executor
    .update(organizationDomains)
    .set({ status })
    .where(
      and(
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteOrganizationDomain(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  const { tx: executor } = requirePlatformWriteContext(context);
  await executor
    .delete(organizationDomains)
    .where(
      and(
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    );
}
