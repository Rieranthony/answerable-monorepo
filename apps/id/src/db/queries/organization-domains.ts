import { beforeCursor, type PageQuery } from "../../http/pagination.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";
import { and, desc, eq } from "drizzle-orm";

import { createId } from "../../lib/id.ts";
import type { Executor } from "../client.ts";
import { organizationDomains, organizations } from "../schema/index.ts";

const normalizeDomain = (domain: string) => domain.trim().toLowerCase();

export async function createOrganizationDomain(
  db: Executor,
  input: { organizationId: string; domain: string },
) {
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

/**
 * The single active organization a domain routes to, or null. The schema
 * guarantees at most one active owner per domain.
 */
export async function findOrganizationByDomain(db: Executor, domain: string) {
  const [organization] = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizationDomains.organizationId, organizations.id),
    )
    .where(
      and(
        eq(organizationDomains.domain, normalizeDomain(domain)),
        eq(organizationDomains.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);

  return organization ?? null;
}

export type DomainQuery = PageQuery & { status?: LifecycleStatus };

export function listOrganizationDomains(
  executor: Executor,
  organizationId: string,
  query: DomainQuery,
) {
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

export async function findOrganizationDomain(
  executor: Executor,
  organizationId: string,
  domainId: string,
) {
  const [row] = await executor
    .select()
    .from(organizationDomains)
    .where(
      and(
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    );
  return row ?? null;
}

export async function setOrganizationDomainStatus(
  executor: Executor,
  organizationId: string,
  domainId: string,
  status: LifecycleStatus,
) {
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
