import type { Executor } from "../client.ts";
import { sql, and, desc, eq, isNull } from "drizzle-orm";
import type { PlatformWriteContext } from "../../services/platform-context.ts";
import type { TenantReadContext } from "../../services/tenant-context.ts";
import type { PageQuery } from "../../http/pagination.ts";
import { beforeCursor, cursorPage, optionalEq } from "./lists.ts";
import type { LifecycleStatus } from "../schema/vocabulary.ts";

import { createId } from "../../lib/id.ts";
import { organizationDomains, organizations } from "../schema/index.ts";

export async function createOrganizationDomain(
  context: PlatformWriteContext,
  input: { organizationId: string; domain: string },
) {
  const { tx: db } = context;
  const [domain] = await db
    .insert(organizationDomains)
    .values({
      id: createId(),
      organizationId: input.organizationId,
      domain: input.domain,
    })
    .returning();

  return domain!;
}

/** Whether this tenant currently accepts the domain; never returns a foreign identity.
 * Domains arrive normalised: the HTTP boundary lowercases and validates them. */
export async function organizationAcceptsDomain(
  context: TenantReadContext<"memberAccess">,
  domain: string,
) {
  const { tx: db, organizationId } = context;
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizationDomains.organizationId, organizations.id),
    )
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.domain, domain),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);

  return organization !== undefined;
}

export async function findDomainOrganizationSlug(db: Executor, domain: string) {
  const [organization] = await db
    .select({ slug: organizations.slug })
    .from(organizationDomains)
    .innerJoin(
      organizations,
      eq(organizationDomains.organizationId, organizations.id),
    )
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.domain, domain),
        eq(organizationDomains.status, "active"),
        eq(organizations.status, "active"),
      ),
    )
    .limit(1);

  return organization?.slug ?? null;
}

export type DomainQuery = PageQuery & { status?: LifecycleStatus };

export async function listOrganizationDomains(
  context: TenantReadContext<"directory">,
  query: DomainQuery,
) {
  const { tx: executor, organizationId } = context;
  return cursorPage(
    await executor
      .select()
      .from(organizationDomains)
      .where(
        and(
          isNull(organizationDomains.deletedAt),
          eq(organizationDomains.organizationId, organizationId),
          optionalEq(organizationDomains.status, query.status),
          beforeCursor(organizationDomains.id, query.cursor),
        ),
      )
      .orderBy(desc(organizationDomains.id))
      .limit(query.limit + 1),
    query.limit,
  );
}

export async function findOrganizationDomainForCommand(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
) {
  const { tx: executor } = context;
  const query = executor
    .select()
    .from(organizationDomains)
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    );
  const [row] = await query.for("update");
  await context.revalidate();
  return row ?? null;
}

export async function setOrganizationDomainStatus(
  context: PlatformWriteContext,
  organizationId: string,
  domainId: string,
  status: LifecycleStatus,
) {
  const { tx: executor } = context;
  const [row] = await executor
    .update(organizationDomains)
    .set({ status })
    .where(
      and(
        isNull(organizationDomains.deletedAt),
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
  const { tx: executor } = context;
  const [row] = await executor
    .update(organizationDomains)
    .set({ deletedAt: sql`now()`, status: "disabled" })
    .where(
      and(
        isNull(organizationDomains.deletedAt),
        eq(organizationDomains.organizationId, organizationId),
        eq(organizationDomains.id, domainId),
      ),
    )
    .returning();
  return row ?? null;
}
