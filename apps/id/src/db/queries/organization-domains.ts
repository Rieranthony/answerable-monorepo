import { and, eq } from "drizzle-orm";

import { createId } from "../../lib/id.ts";
import type { Database } from "../client.ts";
import { organizationDomains, organizations } from "../schema/index.ts";

const normalizeDomain = (domain: string) => domain.trim().toLowerCase();

export async function createOrganizationDomain(
  db: Database,
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
export async function findOrganizationByDomain(db: Database, domain: string) {
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
